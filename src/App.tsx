/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Check,
  RotateCcw,
  User,
  Hash,
  AlertTriangle,
  Printer,
  Gauge,
  Activity,
  PlusCircle,
  Thermometer,
  Wind,
  Play,
  Pause,
  Clock,
  Download,
  Upload,
  Sliders,
  History,
  ArrowRight,
  Trash2,
  BarChart3,
  Eye,
  TrendingUp,
  Cloud,
  Share2,
  RefreshCw,
} from 'lucide-react';
import {
  db,
  doc,
  onSnapshot,
  setDoc,
  getDoc,
  OperationType,
  handleFirestoreError,
} from './firebase';

interface OdCascadeParams {
  currentOd: number;
  referenceOd: number;
  currentRpm: number;
  currentAeration: number;
  currentPressure: number;
  currentTemp: number;
}

interface O2ModificationRecord {
  id: string;
  timestamp: string;
  cultivationElapsed: string;
  operatorName: string;
  triggerOd: number;
  estimatedOdAfter: number;
  stageLabel: string;
  prevRpm: number;
  newRpm: number;
  deltaRpm: number;
  prevAeration: number;
  newAeration: number;
  deltaAeration: number;
  prevPressure: number;
  newPressure: number;
  deltaPressure: number;
  prevTemp: number;
  newTemp: number;
  summary: string;
  operatorNote?: string;
}

interface TwoHourRecord {
  hourMark: number;
  recorded: boolean;
  recordedAt?: string;
  od: number;
  rpm: number;
  aeration: number;
  pressure: number;
  temp: number;
  note?: string;
}

interface CultivationTrackerState {
  isRunning: boolean;
  elapsedSeconds: number;
  lastTickTimestamp: number | null;
  startedClockTime: string | null;
  autoLogEvery2h: boolean;
}

interface BatchState {
  operatorName: string;
  batchNumber: string;
  tankId: string;
  startedAt: string;
  generalNotes: string;
  odParams: OdCascadeParams;
  cultivationTracker: CultivationTrackerState;
  twoHourLogs: Record<number, TwoHourRecord>;
  o2Modifications: O2ModificationRecord[];
  lastPersistedAt?: string;
  updatedAtMs?: number;
}

// Parâmetros Iniciais e Limites Máximos Oficiais do Processo BlueN
const PROCESS_LIMITS = {
  INITIAL_RPM: 95,
  MAX_RPM: 230,
  INITIAL_AERATION: 50,
  MAX_AERATION: 200,
  INITIAL_PRESSURE: 0.6,
  MAX_PRESSURE: 0.85,
  INITIAL_TEMP: 28.0,
  MAX_TEMP: 29.0,
  OD_MIN: 35,
  OD_COMFORT_MIN: 37, // A partir de 36% (e 35%) já recomenda ajuste leve imediato!
  OD_MAX: 40,
  OD_TARGET_MID: 37.5,
};

const TWO_HOURS_SECONDS = 2 * 60 * 60;
const TWO_HOUR_SLOTS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];

const PRIMARY_STORAGE_KEY = 'bluen_persistent_batch_state_v1';
const LEGACY_STORAGE_KEYS = [
  'bluen_o2_parameter_control_v7_saas',
  'bluen_o2_parameter_control_v6',
  'bluen_o2_parameter_control_v5',
];
const DEVICE_ID_STORAGE_KEY = 'bluen_device_session_id';
const FIRESTORE_COLLECTION = 'bioprocessBatches';
const FIRESTORE_DOC_ID = 'active_batch';

const IDB_DB_NAME = 'BlueNBioprocessDB';
const IDB_STORE_NAME = 'batch_state_store';
const IDB_RECORD_KEY = 'active_batch';

function getOrCreateDeviceId(): string {
  try {
    const existing = sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 9)}`;
  }
}

const CURRENT_DEVICE_ID = getOrCreateDeviceId();

function formatCurrentTime(): string {
  const now = new Date();
  return now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatCurrentTimeWithSeconds(): string {
  const now = new Date();
  return now.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCurrentDateTime(): string {
  const now = new Date();
  return now.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPressure(val: number): string {
  return val.toFixed(3).replace('.', ',');
}

function formatCountdownHms(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

const DEFAULT_OD_PARAMS: OdCascadeParams = {
  currentOd: 36,
  referenceOd: 37,
  currentRpm: PROCESS_LIMITS.INITIAL_RPM,
  currentAeration: PROCESS_LIMITS.INITIAL_AERATION,
  currentPressure: PROCESS_LIMITS.INITIAL_PRESSURE,
  currentTemp: PROCESS_LIMITS.INITIAL_TEMP,
};

const DEFAULT_CULTIVATION_TRACKER: CultivationTrackerState = {
  isRunning: false,
  elapsedSeconds: 0,
  lastTickTimestamp: null,
  startedClockTime: null,
  autoLogEvery2h: true,
};

function createDefaultTwoHourLogs(): Record<number, TwoHourRecord> {
  const map: Record<number, TwoHourRecord> = {};
  TWO_HOUR_SLOTS.forEach((hr) => {
    map[hr] = {
      hourMark: hr,
      recorded: hr === 0,
      recordedAt: hr === 0 ? formatCurrentTime() : '',
      od: hr === 0 ? 37.0 : 37.0,
      rpm: PROCESS_LIMITS.INITIAL_RPM,
      aeration: PROCESS_LIMITS.INITIAL_AERATION,
      pressure: PROCESS_LIMITS.INITIAL_PRESSURE,
      temp: PROCESS_LIMITS.INITIAL_TEMP,
      note: hr === 0 ? 'Partida inicial do cultivo' : '',
    };
  });
  return map;
}

// Calcula uma pontuação de uso real para saber qual dispositivo tem os dados mais completos da batelada
function computeBatchActivityScore(state: Partial<BatchState> | Record<string, any>): number {
  if (!state || typeof state !== 'object') return 0;
  let score = 0;
  if (Array.isArray(state.o2Modifications)) {
    score += state.o2Modifications.length * 25;
  }
  if (state.twoHourLogs && typeof state.twoHourLogs === 'object') {
    const recordedCount = TWO_HOUR_SLOTS.filter(
      (hr) =>
        hr > 0 &&
        (state.twoHourLogs[hr]?.recorded || state.twoHourLogs[String(hr)]?.recorded)
    ).length;
    score += recordedCount * 15;
  }
  if (state.operatorName && String(state.operatorName).trim().length > 0) score += 10;
  if (state.batchNumber && String(state.batchNumber).trim().length > 0) score += 10;
  if (state.generalNotes && String(state.generalNotes).trim().length > 0) score += 5;
  if ((state.cultivationTracker?.elapsedSeconds ?? 0) > 0) score += 8;
  if ((state.odParams?.currentRpm ?? 95) !== 95) score += 5;
  if ((state.odParams?.currentAeration ?? 50) !== 50) score += 5;
  if ((state.odParams?.currentPressure ?? 0.6) !== 0.6) score += 5;
  return score;
}

function hydrateParsedBatchState(parsed: Record<string, any>): BatchState {
  const savedCultivation: CultivationTrackerState =
    parsed.cultivationTracker ?? DEFAULT_CULTIVATION_TRACKER;
  let computedElapsed = savedCultivation.elapsedSeconds ?? 0;

  if (savedCultivation.isRunning && savedCultivation.lastTickTimestamp) {
    const deltaSec = Math.max(
      0,
      Math.round((Date.now() - savedCultivation.lastTickTimestamp) / 1000)
    );
    computedElapsed += deltaSec;
  }

  const hydratedOdParams: OdCascadeParams = {
    currentOd: Number(parsed.odParams?.currentOd ?? DEFAULT_OD_PARAMS.currentOd),
    referenceOd: Number(parsed.odParams?.referenceOd ?? 37),
    currentRpm: Math.min(
      PROCESS_LIMITS.MAX_RPM,
      Number(parsed.odParams?.currentRpm ?? DEFAULT_OD_PARAMS.currentRpm)
    ),
    currentAeration: Math.min(
      PROCESS_LIMITS.MAX_AERATION,
      Number(parsed.odParams?.currentAeration ?? DEFAULT_OD_PARAMS.currentAeration)
    ),
    currentPressure: Math.min(
      PROCESS_LIMITS.MAX_PRESSURE,
      Number(parsed.odParams?.currentPressure ?? DEFAULT_OD_PARAMS.currentPressure)
    ),
    currentTemp: Number(parsed.odParams?.currentTemp ?? DEFAULT_OD_PARAMS.currentTemp),
  };

  const defaultLogs = createDefaultTwoHourLogs();
  const rawLogs = parsed.twoHourLogs ?? defaultLogs;
  const hydratedTwoHourLogs: Record<number, TwoHourRecord> = {};

  TWO_HOUR_SLOTS.forEach((hr) => {
    const item = rawLogs[hr] ?? rawLogs[String(hr)] ?? defaultLogs[hr];
    hydratedTwoHourLogs[hr] = {
      hourMark: hr,
      recorded: Boolean(item?.recorded),
      recordedAt: item?.recordedAt ? String(item.recordedAt) : '',
      od: Number(item?.od ?? 37.0),
      rpm: Number(item?.rpm ?? PROCESS_LIMITS.INITIAL_RPM),
      aeration: Number(item?.aeration ?? PROCESS_LIMITS.INITIAL_AERATION),
      pressure: Number(item?.pressure ?? PROCESS_LIMITS.INITIAL_PRESSURE),
      temp: Number(item?.temp ?? PROCESS_LIMITS.INITIAL_TEMP),
      note: item?.note ? String(item.note) : '',
    };
  });

  if (savedCultivation.isRunning && (savedCultivation.autoLogEvery2h ?? true)) {
    TWO_HOUR_SLOTS.forEach((slotHour) => {
      const slotSeconds = slotHour * 3600;
      if (
        slotHour > 0 &&
        computedElapsed >= slotSeconds &&
        !hydratedTwoHourLogs[slotHour]?.recorded
      ) {
        hydratedTwoHourLogs[slotHour] = {
          hourMark: slotHour,
          recorded: true,
          recordedAt: formatCurrentTime(),
          od: hydratedOdParams.currentOd,
          rpm: hydratedOdParams.currentRpm,
          aeration: hydratedOdParams.currentAeration,
          pressure: hydratedOdParams.currentPressure,
          temp: hydratedOdParams.currentTemp,
          note: 'Registro automático de 2h',
        };
      }
    });
  }

  return {
    operatorName: String(parsed.operatorName ?? '').slice(0, 120),
    batchNumber: String(parsed.batchNumber ?? '').slice(0, 80),
    tankId: String(parsed.tankId ?? 'Reator BlueN-01').slice(0, 80),
    startedAt: String(parsed.startedAt ?? formatCurrentDateTime()).slice(0, 60),
    generalNotes: String(parsed.generalNotes ?? '').slice(0, 3000),
    odParams: hydratedOdParams,
    cultivationTracker: {
      isRunning: Boolean(savedCultivation.isRunning),
      elapsedSeconds: Math.max(0, Math.min(864000, Math.floor(computedElapsed))),
      lastTickTimestamp: savedCultivation.isRunning ? Date.now() : null,
      startedClockTime: savedCultivation.startedClockTime
        ? String(savedCultivation.startedClockTime).slice(0, 30)
        : null,
      autoLogEvery2h: Boolean(savedCultivation.autoLogEvery2h ?? true),
    },
    twoHourLogs: hydratedTwoHourLogs,
    o2Modifications: Array.isArray(parsed.o2Modifications)
      ? parsed.o2Modifications.slice(0, 200)
      : [],
    lastPersistedAt:
      parsed.updatedAtClient ?? parsed.lastPersistedAt ?? formatCurrentTimeWithSeconds(),
    updatedAtMs: Number(parsed.updatedAtMs ?? 0),
  };
}

function buildFirestorePayload(state: BatchState) {
  const cleanTwoHourLogs: Record<string, any> = {};
  TWO_HOUR_SLOTS.forEach((hr) => {
    const rec = state.twoHourLogs[hr];
    cleanTwoHourLogs[String(hr)] = {
      hourMark: hr,
      recorded: Boolean(rec?.recorded),
      recordedAt: String(rec?.recordedAt ?? ''),
      od: Number(rec?.od ?? 37.0),
      rpm: Number(rec?.rpm ?? PROCESS_LIMITS.INITIAL_RPM),
      aeration: Number(rec?.aeration ?? PROCESS_LIMITS.INITIAL_AERATION),
      pressure: Number(rec?.pressure ?? PROCESS_LIMITS.INITIAL_PRESSURE),
      temp: Number(rec?.temp ?? PROCESS_LIMITS.INITIAL_TEMP),
      note: String(rec?.note ?? ''),
    };
  });

  const cleanModifications = state.o2Modifications.slice(0, 200).map((m) => ({
    id: String(m.id ?? ''),
    timestamp: String(m.timestamp ?? ''),
    cultivationElapsed: String(m.cultivationElapsed ?? ''),
    operatorName: String(m.operatorName ?? 'Operador').slice(0, 120),
    triggerOd: Number(m.triggerOd ?? 37),
    estimatedOdAfter: Number(m.estimatedOdAfter ?? 37),
    stageLabel: String(m.stageLabel ?? ''),
    prevRpm: Number(m.prevRpm ?? 95),
    newRpm: Number(m.newRpm ?? 95),
    deltaRpm: Number(m.deltaRpm ?? 0),
    prevAeration: Number(m.prevAeration ?? 50),
    newAeration: Number(m.newAeration ?? 50),
    deltaAeration: Number(m.deltaAeration ?? 0),
    prevPressure: Number(m.prevPressure ?? 0.6),
    newPressure: Number(m.newPressure ?? 0.6),
    deltaPressure: Number(m.deltaPressure ?? 0),
    prevTemp: Number(m.prevTemp ?? 28),
    newTemp: Number(m.newTemp ?? 28),
    summary: String(m.summary ?? ''),
    operatorNote: String(m.operatorNote ?? ''),
  }));

  const nowClock = formatCurrentTimeWithSeconds();
  const nowMs = Date.now();

  return {
    operatorName: String(state.operatorName ?? '').slice(0, 120),
    batchNumber: String(state.batchNumber ?? '').slice(0, 80),
    tankId: String(state.tankId ?? 'Reator BlueN-01').slice(0, 80),
    startedAt: String(state.startedAt ?? formatCurrentDateTime()).slice(0, 60),
    generalNotes: String(state.generalNotes ?? '').slice(0, 3000),
    odParams: {
      currentOd: Math.max(0, Math.min(100, Number(state.odParams.currentOd ?? 36))),
      referenceOd: Math.max(0, Math.min(100, Number(state.odParams.referenceOd ?? 37))),
      currentRpm: Math.max(0, Math.min(230, Number(state.odParams.currentRpm ?? 95))),
      currentAeration: Math.max(0, Math.min(200, Number(state.odParams.currentAeration ?? 50))),
      currentPressure: Math.max(0, Math.min(0.85, Number(state.odParams.currentPressure ?? 0.6))),
      currentTemp: Math.max(0, Math.min(60, Number(state.odParams.currentTemp ?? 28))),
    },
    cultivationTracker: {
      isRunning: Boolean(state.cultivationTracker.isRunning),
      elapsedSeconds: Math.max(
        0,
        Math.min(864000, Math.floor(Number(state.cultivationTracker.elapsedSeconds ?? 0)))
      ),
      lastTickTimestamp: state.cultivationTracker.isRunning ? nowMs : null,
      startedClockTime: state.cultivationTracker.startedClockTime
        ? String(state.cultivationTracker.startedClockTime).slice(0, 30)
        : null,
      autoLogEvery2h: Boolean(state.cultivationTracker.autoLogEvery2h ?? true),
    },
    twoHourLogs: cleanTwoHourLogs,
    o2Modifications: cleanModifications,
    updatedAtClient: nowClock,
    updatedAtMs: nowMs,
    updatedByDevice: CURRENT_DEVICE_ID,
  };
}

function saveBatchToIndexedDB(state: BatchState): void {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return;
  try {
    const request = window.indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains(IDB_STORE_NAME)) {
        idb.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const idb = request.result;
      const tx = idb.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(state, IDB_RECORD_KEY);
      tx.oncomplete = () => idb.close();
    };
  } catch {
    // ignore IndexedDB errors
  }
}

function persistStateLocally(state: BatchState): void {
  try {
    const payload = JSON.stringify({
      ...state,
      cultivationTracker: {
        ...state.cultivationTracker,
        lastTickTimestamp: state.cultivationTracker.isRunning ? Date.now() : null,
      },
      lastPersistedAt: formatCurrentTimeWithSeconds(),
    });
    localStorage.setItem(PRIMARY_STORAGE_KEY, payload);
    localStorage.setItem(LEGACY_STORAGE_KEYS[0], payload);
  } catch {
    // ignore storage quota errors
  }
  saveBatchToIndexedDB(state);
}

function getInitialState(): BatchState {
  try {
    const allKeysToCheck = [PRIMARY_STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
    for (const key of allKeysToCheck) {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return hydrateParsedBatchState(parsed);
        }
      }
    }
  } catch {
    // ignore storage errors
  }
  return {
    operatorName: '',
    batchNumber: '',
    tankId: 'Reator BlueN-01',
    startedAt: formatCurrentDateTime(),
    generalNotes: '',
    odParams: DEFAULT_OD_PARAMS,
    cultivationTracker: DEFAULT_CULTIVATION_TRACKER,
    twoHourLogs: createDefaultTwoHourLogs(),
    o2Modifications: [],
    lastPersistedAt: formatCurrentTimeWithSeconds(),
    updatedAtMs: 0,
  };
}

// ============================================================================
// COMPONENTE DE GRÁFICO INDUSTRIAL SVG (APENAS VISUALIZAÇÃO)
// ============================================================================
interface TelemetryPoint {
  label: string;
  sublabel?: string;
  value: number;
  secondaryValue?: number;
  note?: string;
}

interface TelemetryChartProps {
  title: string;
  subtitle: string;
  unit: string;
  data: TelemetryPoint[];
  yMin: number;
  yMax: number;
  strokeColor: string;
  fillGradientId: string;
  secondaryLabel?: string;
  secondaryColor?: string;
  targetBand?: { min: number; max: number; label: string };
  limitLine?: { value: number; label: string; color?: string };
  initialLine?: { value: number; label: string };
  formatValue?: (val: number) => string;
  height?: number;
}

function TelemetryLineChart({
  title,
  subtitle,
  unit,
  data,
  yMin,
  yMax,
  strokeColor,
  fillGradientId,
  secondaryLabel,
  secondaryColor = '#34d399',
  targetBand,
  limitLine,
  initialLine,
  formatValue = (v) => String(v).replace('.', ','),
  height = 250,
}: TelemetryChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const svgWidth = 760;
  const svgHeight = height;
  const padLeft = 54;
  const padRight = 28;
  const padTop = 28;
  const padBottom = 44;

  const plotWidth = svgWidth - padLeft - padRight;
  const plotHeight = svgHeight - padTop - padBottom;

  const clampY = (val: number) => {
    const ratio = (val - yMin) / Math.max(0.0001, yMax - yMin);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    return padTop + plotHeight - clampedRatio * plotHeight;
  };

  const getX = (idx: number, count: number) => {
    if (count <= 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (count - 1)) * plotWidth;
  };

  const yTicks = useMemo(() => {
    const steps = 4;
    const arr: number[] = [];
    for (let i = 0; i <= steps; i++) {
      arr.push(yMin + ((yMax - yMin) * i) / steps);
    }
    return arr;
  }, [yMin, yMax]);

  const pointsCoords = data.map((d, i) => ({
    x: getX(i, data.length),
    y: clampY(d.value),
    secY: d.secondaryValue !== undefined ? clampY(d.secondaryValue) : undefined,
    raw: d,
  }));

  const polylinePoints = pointsCoords.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPoints =
    pointsCoords.length > 0
      ? `${pointsCoords[0].x},${padTop + plotHeight} ${polylinePoints} ${
          pointsCoords[pointsCoords.length - 1].x
        },${padTop + plotHeight}`
      : '';

  const secondaryPolylinePoints =
    secondaryLabel && pointsCoords.every((p) => p.secY !== undefined)
      ? pointsCoords.map((p) => `${p.x},${p.secY}`).join(' ')
      : null;

  const latestPoint = data.length > 0 ? data[data.length - 1] : null;
  const activePoint = hoveredIdx !== null && data[hoveredIdx] ? data[hoveredIdx] : latestPoint;

  return (
    <div className="bg-[#090D16] border border-slate-800/90 rounded-xl p-4 flex flex-col justify-between space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-xs inline-block shrink-0"
              style={{ backgroundColor: strokeColor }}
            />
            <span>{title}</span>
          </h4>
          <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
        </div>

        {activePoint && (
          <div className="text-right font-mono tabular-nums">
            <div className="flex items-center justify-end gap-2">
              <span className="text-[11px] text-slate-400">
                {hoveredIdx !== null
                  ? `Selecionado (${activePoint.label}):`
                  : `Último (${activePoint.label}):`}
              </span>
              <span className="text-base font-bold text-white">
                {formatValue(activePoint.value)} {unit}
              </span>
            </div>
            {secondaryLabel && activePoint.secondaryValue !== undefined && (
              <div className="text-[11px] text-emerald-400">
                {secondaryLabel}: {formatValue(activePoint.secondaryValue)} {unit}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-auto select-none overflow-visible"
          role="img"
          aria-label={title}
        >
          <defs>
            <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {yTicks.map((tickVal, idx) => {
            const yPos = clampY(tickVal);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={yPos}
                  x2={svgWidth - padRight}
                  y2={yPos}
                  stroke="#1e293b"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 8}
                  y={yPos + 4}
                  textAnchor="end"
                  className="fill-slate-500 font-mono text-[10px]"
                >
                  {formatValue(Number(tickVal.toFixed(2)))}
                </text>
              </g>
            );
          })}

          {targetBand && (
            <g>
              <rect
                x={padLeft}
                y={clampY(targetBand.max)}
                width={plotWidth}
                height={Math.max(2, clampY(targetBand.min) - clampY(targetBand.max))}
                fill="#10b981"
                fillOpacity="0.11"
              />
              <line
                x1={padLeft}
                y1={clampY(targetBand.min)}
                x2={svgWidth - padRight}
                y2={clampY(targetBand.min)}
                stroke="#10b981"
                strokeDasharray="4 4"
                strokeWidth="1"
                strokeOpacity="0.7"
              />
              <line
                x1={padLeft}
                y1={clampY(targetBand.max)}
                x2={svgWidth - padRight}
                y2={clampY(targetBand.max)}
                stroke="#10b981"
                strokeDasharray="4 4"
                strokeWidth="1"
                strokeOpacity="0.7"
              />
              <text
                x={svgWidth - padRight - 4}
                y={clampY(targetBand.max) + 11}
                textAnchor="end"
                className="fill-emerald-400 font-mono text-[9px] font-semibold"
              >
                {targetBand.label}
              </text>
            </g>
          )}

          {initialLine && (
            <g>
              <line
                x1={padLeft}
                y1={clampY(initialLine.value)}
                x2={svgWidth - padRight}
                y2={clampY(initialLine.value)}
                stroke="#64748b"
                strokeDasharray="2 4"
                strokeWidth="1"
              />
              <text
                x={padLeft + 6}
                y={clampY(initialLine.value) - 5}
                className="fill-slate-400 font-mono text-[9px]"
              >
                {initialLine.label}
              </text>
            </g>
          )}

          {limitLine && (
            <g>
              <line
                x1={padLeft}
                y1={clampY(limitLine.value)}
                x2={svgWidth - padRight}
                y2={clampY(limitLine.value)}
                stroke={limitLine.color || '#f59e0b'}
                strokeDasharray="5 3"
                strokeWidth="1.2"
              />
              <text
                x={svgWidth - padRight - 4}
                y={clampY(limitLine.value) - 5}
                textAnchor="end"
                className="fill-amber-400 font-mono text-[9px] font-semibold"
              >
                {limitLine.label}
              </text>
            </g>
          )}

          {pointsCoords.length > 1 && (
            <polygon points={areaPoints} fill={`url(#${fillGradientId})`} />
          )}

          {secondaryPolylinePoints && pointsCoords.length > 1 && (
            <polyline
              fill="none"
              stroke={secondaryColor}
              strokeWidth="2"
              strokeDasharray="4 3"
              points={secondaryPolylinePoints}
            />
          )}

          {pointsCoords.length > 1 && (
            <polyline
              fill="none"
              stroke={strokeColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={polylinePoints}
            />
          )}

          {pointsCoords.map((pt, idx) => {
            const isHovered = hoveredIdx === idx;
            return (
              <g
                key={idx}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="cursor-pointer"
              >
                {isHovered && (
                  <line
                    x1={pt.x}
                    y1={padTop}
                    x2={pt.x}
                    y2={padTop + plotHeight}
                    stroke="#38bdf8"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                )}

                {pt.secY !== undefined && (
                  <circle
                    cx={pt.x}
                    cy={pt.secY}
                    r={isHovered ? 5 : 3.5}
                    fill="#090D16"
                    stroke={secondaryColor}
                    strokeWidth="2"
                  />
                )}

                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 6 : 4.5}
                  fill="#090D16"
                  stroke={strokeColor}
                  strokeWidth={isHovered ? 3 : 2.2}
                />

                <text
                  x={pt.x}
                  y={pt.y - 10}
                  textAnchor="middle"
                  className={`font-mono text-[10px] font-bold ${
                    isHovered ? 'fill-white' : 'fill-slate-200'
                  }`}
                >
                  {formatValue(pt.raw.value)}
                </text>

                <text
                  x={pt.x}
                  y={padTop + plotHeight + 16}
                  textAnchor="middle"
                  className={`font-mono text-[10px] ${
                    isHovered ? 'fill-sky-400 font-bold' : 'fill-slate-400'
                  }`}
                >
                  {pt.raw.label}
                </text>

                {pt.raw.sublabel && (
                  <text
                    x={pt.x}
                    y={padTop + plotHeight + 29}
                    textAnchor="middle"
                    className="fill-slate-500 font-mono text-[9px]"
                  >
                    {pt.raw.sublabel}
                  </text>
                )}

                <rect
                  x={pt.x - 18}
                  y={padTop}
                  width={36}
                  height={plotHeight + padBottom}
                  fill="transparent"
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono text-slate-400 border-t border-slate-800/60">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: strokeColor }} />
            <span>Série Principal ({unit})</span>
          </span>
          {secondaryLabel && (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span
                className="w-2.5 h-0.5 inline-block"
                style={{ backgroundColor: secondaryColor }}
              />
              <span>{secondaryLabel}</span>
            </span>
          )}
        </div>
        {activePoint?.note && (
          <span className="text-slate-300 font-sans truncate max-w-md">{activePoint.note}</span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [batch, setBatch] = useState<BatchState>(getInitialState);
  const [activeTab, setActiveTab] = useState<'operacao' | 'graficos'>('operacao');
  const [chartSourceFilter, setChartSourceFilter] = useState<'ambos' | 'ajustes' | '2h'>('ambos');
  const [manualO2Input, setManualO2Input] = useState<string>(() =>
    String(batch.odParams.currentOd).replace('.', ',')
  );
  const [modificationReasonInput, setModificationReasonInput] = useState<string>('');
  const [lastSavedBanner, setLastSavedBanner] = useState<string | null>(null);
  const [editingSlotHour, setEditingSlotHour] = useState<number | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Estado de sincronização em nuvem (Firebase Firestore em Tempo Real)
  const [cloudStatus, setCloudStatus] = useState<'connecting' | 'synced' | 'error'>('connecting');
  const [lastCloudSyncTime, setLastCloudSyncTime] = useState<string>(() =>
    formatCurrentTimeWithSeconds()
  );
  const [copiedLinkNotice, setCopiedLinkNotice] = useState<boolean>(false);

  const latestBatchRef = useRef<BatchState>(batch);
  const hasLoadedInitialCloudRef = useRef<boolean>(false);
  const debounceSyncTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Envia o estado atual diretamente para o documento compartilhado no Firestore
  const pushBatchToFirestore = async (stateToSync: BatchState) => {
    const docPath = `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`;
    try {
      const payload = buildFirestorePayload(stateToSync);
      await setDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID), payload);
      setCloudStatus('synced');
      setLastCloudSyncTime(payload.updatedAtClient);
    } catch (error) {
      setCloudStatus('error');
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
  };

  // Helper centralizado para qualquer alteração feita pelo usuário:
  // Atualiza a tela na hora, grava no dispositivo e envia imediatamente para a nuvem (todos os dispositivos recebem via onSnapshot)
  const commitUserBatchUpdate = (
    updater: (prev: BatchState) => BatchState,
    options?: { immediateCloudPush?: boolean }
  ) => {
    setBatch((prev) => {
      const next = {
        ...updater(prev),
        updatedAtMs: Date.now(),
      };
      latestBatchRef.current = next;
      persistStateLocally(next);

      if (debounceSyncTimerRef.current) {
        window.clearTimeout(debounceSyncTimerRef.current);
      }

      if (options?.immediateCloudPush) {
        pushBatchToFirestore(next);
      } else {
        debounceSyncTimerRef.current = window.setTimeout(() => {
          pushBatchToFirestore(latestBatchRef.current);
        }, 120);
      }

      return next;
    });
  };

  // Força sincronização manual caso o operador queira puxar/enviar na hora
  const handleManualCloudSync = async () => {
    const docPath = `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`;
    try {
      setCloudStatus('connecting');
      const snap = await getDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID));
      if (snap.exists()) {
        const cloudData = snap.data();
        const cloudScore = computeBatchActivityScore(cloudData);
        const localScore = computeBatchActivityScore(latestBatchRef.current);

        if (localScore > cloudScore) {
          await pushBatchToFirestore(latestBatchRef.current);
        } else {
          const hydrated = hydrateParsedBatchState(cloudData);
          latestBatchRef.current = hydrated;
          setBatch(hydrated);
          persistStateLocally(hydrated);
          setManualO2Input(String(hydrated.odParams.currentOd).replace('.', ','));
          setCloudStatus('synced');
          setLastCloudSyncTime(cloudData.updatedAtClient || formatCurrentTimeWithSeconds());
        }
      } else {
        await pushBatchToFirestore(latestBatchRef.current);
      }
    } catch (error) {
      setCloudStatus('error');
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  };

  // Listener em Tempo Real (onSnapshot) para que TODOS os dispositivos vejam exatamente a mesma tela
  useEffect(() => {
    const docRef = doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC_ID);
    const docPath = `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`;

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        setCloudStatus('synced');
        if (snapshot.exists()) {
          const cloudData = snapshot.data();

          // Na primeira leitura ao abrir a página, verifica se este dispositivo (ex: tablet do operador)
          // já tinha mais dados locais do que um documento vazio na nuvem
          if (!hasLoadedInitialCloudRef.current) {
            hasLoadedInitialCloudRef.current = true;
            const localScore = computeBatchActivityScore(latestBatchRef.current);
            const cloudScore = computeBatchActivityScore(cloudData);

            if (localScore > cloudScore && cloudScore === 0) {
              // Publica os dados existentes do operador para a nuvem para que todos vejam
              pushBatchToFirestore(latestBatchRef.current);
              return;
            }

            const hydrated = hydrateParsedBatchState(cloudData);
            latestBatchRef.current = hydrated;
            setBatch(hydrated);
            persistStateLocally(hydrated);
            setManualO2Input(String(hydrated.odParams.currentOd).replace('.', ','));
            setLastCloudSyncTime(cloudData.updatedAtClient || formatCurrentTimeWithSeconds());
            return;
          }

          // Nas atualizações em tempo real seguintes vindas de qualquer dispositivo
          if (cloudData.updatedByDevice !== CURRENT_DEVICE_ID) {
            const hydrated = hydrateParsedBatchState(cloudData);
            latestBatchRef.current = hydrated;
            setBatch(hydrated);
            persistStateLocally(hydrated);
            setManualO2Input(String(hydrated.odParams.currentOd).replace('.', ','));
            setLastCloudSyncTime(cloudData.updatedAtClient || formatCurrentTimeWithSeconds());
          }
        } else if (!hasLoadedInitialCloudRef.current) {
          hasLoadedInitialCloudRef.current = true;
          pushBatchToFirestore(latestBatchRef.current);
        }
      },
      (error) => {
        setCloudStatus('error');
        handleFirestoreError(error, OperationType.GET, docPath);
      }
    );

    return () => unsubscribe();
  }, []);

  // Garante gravação imediata ao fechar a aba, atualizar a página ou minimizar no tablet
  useEffect(() => {
    const handleFlushOnClose = () => {
      persistStateLocally(latestBatchRef.current);
      if (hasLoadedInitialCloudRef.current) {
        pushBatchToFirestore(latestBatchRef.current);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleFlushOnClose();
      }
    };

    window.addEventListener('beforeunload', handleFlushOnClose);
    window.addEventListener('pagehide', handleFlushOnClose);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleFlushOnClose);
      window.removeEventListener('pagehide', handleFlushOnClose);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const parsedCurrent = parseFloat(manualO2Input.replace(',', '.'));
    if (parsedCurrent !== batch.odParams.currentOd) {
      setManualO2Input(String(batch.odParams.currentOd).replace('.', ','));
    }
  }, [batch.odParams.currentOd]);

  // Cronômetro de Tempo de Cultivo + Auto-registro 2h
  useEffect(() => {
    if (!batch.cultivationTracker.isRunning) {
      return;
    }

    const interval = window.setInterval(() => {
      setBatch((prev) => {
        if (!prev.cultivationTracker.isRunning) return prev;
        const nextElapsed = prev.cultivationTracker.elapsedSeconds + 1;
        const nextTwoHourLogs = { ...prev.twoHourLogs };
        let crossedTwoHourMark = false;

        if (prev.cultivationTracker.autoLogEvery2h) {
          TWO_HOUR_SLOTS.forEach((slotHour) => {
            const slotSeconds = slotHour * 3600;
            if (
              slotHour > 0 &&
              nextElapsed >= slotSeconds &&
              !nextTwoHourLogs[slotHour]?.recorded
            ) {
              crossedTwoHourMark = true;
              nextTwoHourLogs[slotHour] = {
                hourMark: slotHour,
                recorded: true,
                recordedAt: formatCurrentTime(),
                od: prev.odParams.currentOd,
                rpm: prev.odParams.currentRpm,
                aeration: prev.odParams.currentAeration,
                pressure: prev.odParams.currentPressure,
                temp: prev.odParams.currentTemp,
                note: 'Registro automático de 2h',
              };
            }
          });
        }

        const nextState: BatchState = {
          ...prev,
          cultivationTracker: {
            ...prev.cultivationTracker,
            elapsedSeconds: nextElapsed,
            lastTickTimestamp: Date.now(),
          },
          twoHourLogs: nextTwoHourLogs,
        };

        latestBatchRef.current = nextState;
        persistStateLocally(nextState);

        // Sincroniza na nuvem quando cruza uma janela de 2h ou a cada 15 segundos de cultivo ativo
        if (crossedTwoHourMark || nextElapsed % 15 === 0) {
          pushBatchToFirestore(nextState);
        }

        return nextState;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [batch.cultivationTracker.isRunning]);

  const handleCopySharedLink = () => {
    try {
      navigator.clipboard.writeText(window.location.href);
      setCopiedLinkNotice(true);
      window.setTimeout(() => setCopiedLinkNotice(false), 4000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleManualO2TextChange = (rawText: string) => {
    setManualO2Input(rawText);
    const normalized = rawText.replace(',', '.').trim();
    if (normalized === '') return;
    const numeric = parseFloat(normalized);
    if (!Number.isNaN(numeric)) {
      const clamped = Math.max(0, Math.min(100, numeric));
      commitUserBatchUpdate((prev) => ({
        ...prev,
        odParams: {
          ...prev.odParams,
          currentOd: clamped,
        },
      }));
    }
  };

  const startCultivationTracker = () => {
    const nowTime = formatCurrentTime();
    commitUserBatchUpdate(
      (prev) => {
        const updatedTwoHour = { ...prev.twoHourLogs };
        if (!updatedTwoHour[0]?.recorded) {
          updatedTwoHour[0] = {
            hourMark: 0,
            recorded: true,
            recordedAt: nowTime,
            od: prev.odParams.currentOd,
            rpm: prev.odParams.currentRpm,
            aeration: prev.odParams.currentAeration,
            pressure: prev.odParams.currentPressure,
            temp: prev.odParams.currentTemp,
            note: 'Partida do cultivo (0h)',
          };
        }

        return {
          ...prev,
          cultivationTracker: {
            ...prev.cultivationTracker,
            isRunning: true,
            lastTickTimestamp: Date.now(),
            startedClockTime: prev.cultivationTracker.startedClockTime ?? nowTime,
          },
          twoHourLogs: updatedTwoHour,
        };
      },
      { immediateCloudPush: true }
    );
  };

  const pauseCultivationTracker = () => {
    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        cultivationTracker: {
          ...prev.cultivationTracker,
          isRunning: false,
          lastTickTimestamp: null,
        },
      }),
      { immediateCloudPush: true }
    );
  };

  const recordNextTwoHourSlotNow = () => {
    const nowTime = formatCurrentTime();
    commitUserBatchUpdate(
      (prev) => {
        const nextUnrecordedSlot = TWO_HOUR_SLOTS.find((hr) => !prev.twoHourLogs[hr]?.recorded);
        if (nextUnrecordedSlot === undefined) {
          return prev;
        }

        const updatedTwoHour = {
          ...prev.twoHourLogs,
          [nextUnrecordedSlot]: {
            hourMark: nextUnrecordedSlot,
            recorded: true,
            recordedAt: nowTime,
            od: prev.odParams.currentOd,
            rpm: prev.odParams.currentRpm,
            aeration: prev.odParams.currentAeration,
            pressure: prev.odParams.currentPressure,
            temp: prev.odParams.currentTemp,
            note: `Reporte de ${nextUnrecordedSlot}h registrado pelo operador`,
          },
        };

        const minElapsedForSlot = nextUnrecordedSlot * 3600;
        const nextElapsed = Math.max(prev.cultivationTracker.elapsedSeconds, minElapsedForSlot);

        return {
          ...prev,
          cultivationTracker: {
            ...prev.cultivationTracker,
            elapsedSeconds: nextElapsed,
            startedClockTime: prev.cultivationTracker.startedClockTime ?? nowTime,
          },
          twoHourLogs: updatedTwoHour,
        };
      },
      { immediateCloudPush: true }
    );
  };

  const recordSpecificTwoHourSlot = (hourMark: number) => {
    const nowTime = formatCurrentTime();
    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        twoHourLogs: {
          ...prev.twoHourLogs,
          [hourMark]: {
            ...prev.twoHourLogs[hourMark],
            hourMark,
            recorded: true,
            recordedAt: nowTime,
            od: prev.odParams.currentOd,
            rpm: prev.odParams.currentRpm,
            aeration: prev.odParams.currentAeration,
            pressure: prev.odParams.currentPressure,
            temp: prev.odParams.currentTemp,
            note: prev.twoHourLogs[hourMark]?.note || `Reporte ${hourMark}h`,
          },
        },
      }),
      { immediateCloudPush: true }
    );
  };

  const updateTwoHourSlotField = (
    hourMark: number,
    field: keyof TwoHourRecord,
    value: number | string | boolean
  ) => {
    commitUserBatchUpdate((prev) => ({
      ...prev,
      twoHourLogs: {
        ...prev.twoHourLogs,
        [hourMark]: {
          ...prev.twoHourLogs[hourMark],
          [field]: value,
          recorded: true,
          recordedAt: prev.twoHourLogs[hourMark]?.recordedAt || formatCurrentTime(),
        },
      },
    }));
  };

  const clearTwoHourSlot = (hourMark: number) => {
    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        twoHourLogs: {
          ...prev.twoHourLogs,
          [hourMark]: {
            hourMark,
            recorded: false,
            recordedAt: '',
            od: 37.0,
            rpm: PROCESS_LIMITS.INITIAL_RPM,
            aeration: PROCESS_LIMITS.INITIAL_AERATION,
            pressure: PROCESS_LIMITS.INITIAL_PRESSURE,
            temp: PROCESS_LIMITS.INITIAL_TEMP,
            note: '',
          },
        },
      }),
      { immediateCloudPush: true }
    );
    if (editingSlotHour === hourMark) {
      setEditingSlotHour(null);
    }
  };

  const updateOdParam = (
    key: keyof OdCascadeParams,
    value: number,
    immediateCloudPush = false
  ) => {
    const cleanVal = Number.isNaN(value) ? 0 : value;
    let clamped = cleanVal;
    if (key === 'currentRpm') {
      clamped = Math.max(0, Math.min(PROCESS_LIMITS.MAX_RPM, cleanVal));
    } else if (key === 'currentAeration') {
      clamped = Math.max(0, Math.min(PROCESS_LIMITS.MAX_AERATION, cleanVal));
    } else if (key === 'currentPressure') {
      clamped = Math.max(0, Math.min(PROCESS_LIMITS.MAX_PRESSURE, cleanVal));
    } else if (key === 'currentOd') {
      clamped = Math.max(0, Math.min(100, cleanVal));
    }

    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        odParams: {
          ...prev.odParams,
          [key]: clamped,
        },
      }),
      { immediateCloudPush }
    );
  };

  // ==========================================================================
  // CÁLCULO EM CASCATA DE O₂:
  // - O₂ ≥ 37%: Estável (Manter)
  // - O₂ em 36% (36,0% a 36,9%): Já recomenda Ajuste Leve imediato (+5 RPM / +5 L/min / +0,025 bar)
  // - O₂ em 35% (35,0% a 35,9%): Já recomenda Ajuste Leve/Preventivo (+10 RPM / +10 L/min / +0,025 bar)
  // - O₂ ≤ 34,9% (34%, 30%, 28%...): Cascata Corretiva Proporcional
  // ==========================================================================
  const cascadeCalculation = useMemo(() => {
    const {
      currentOd,
      currentRpm,
      currentAeration,
      currentPressure,
      currentTemp,
    } = batch.odParams;

    const {
      MAX_RPM,
      MAX_AERATION,
      MAX_PRESSURE,
      INITIAL_TEMP,
      MAX_TEMP,
      OD_MIN,
      OD_COMFORT_MIN,
      OD_MAX,
      OD_TARGET_MID,
    } = PROCESS_LIMITS;

    const odGainPerRpm = 1 / 8;
    const odGainPerAeration = 1 / 10;
    const odGainPerPressure = 1 / 0.025;

    const isTempWithinBand = currentTemp >= INITIAL_TEMP && currentTemp <= MAX_TEMP;

    // Somente quando O2 >= 37% considera estável sem recomendação de subida
    if (currentOd >= OD_COMFORT_MIN) {
      return {
        isNominal: true,
        isPreventiveFineAdjustment: false,
        deficitOd: 0,
        activeStage: 'maintain' as const,
        stageLabel: 'Manutenção Nominal (O₂ ≥ 37%)',
        atRpmMax: currentRpm >= MAX_RPM,
        atAerationMax: currentAeration >= MAX_AERATION,
        atPressureMax: currentPressure >= MAX_PRESSURE,
        deltaRpm: 0,
        recommendedRpm: currentRpm,
        deltaAeration: 0,
        recommendedAeration: currentAeration,
        deltaPressure: 0,
        recommendedPressure: currentPressure,
        isTempWithinBand,
        estimatedFinalOd: currentOd,
        operatorActionHeadline: 'MANTER CONDIÇÕES ATUAIS (O₂ ESTÁVEL ≥ 37%)',
      };
    }

    // Qualquer valor entre 35,0% e 36,9% já aciona o Ajuste Leve Preventivo!
    const isPreventiveFineAdjustment = currentOd >= OD_MIN && currentOd < OD_COMFORT_MIN;
    const totalDeficit = Math.max(0.5, Number((OD_TARGET_MID - currentOd).toFixed(1)));
    let remainingDeficit = totalDeficit;

    // 1º PASSO: Agitação (95 -> 230 RPM)
    const availableRpmHeadroom = Math.max(0, MAX_RPM - currentRpm);
    const rawNeededRpm = Math.ceil(remainingDeficit / odGainPerRpm);
    let steppedNeededRpm = Math.max(5, Math.ceil(rawNeededRpm / 5) * 5);

    // Em 36% (36,0 a 36,9%): recomenda ajuste leve imediato de +5 RPM
    // Em 35% (35,0 a 35,9%): recomenda ajuste preventivo imediato de +10 RPM
    if (currentOd >= 36 && currentOd < 37) {
      steppedNeededRpm = 5;
    } else if (currentOd >= 35 && currentOd < 36) {
      steppedNeededRpm = 10;
    }

    const deltaRpm = Math.min(availableRpmHeadroom, steppedNeededRpm);
    const recommendedRpm = currentRpm + deltaRpm;
    const odCoveredByRpm = deltaRpm * odGainPerRpm;
    remainingDeficit = Math.max(0, remainingDeficit - odCoveredByRpm);

    const reachesRpmMax = recommendedRpm >= MAX_RPM;
    const stillNeedsAfterRpm = reachesRpmMax && remainingDeficit > 0.2;

    // 2º PASSO: Vazão de Ar (50 -> 200 L/min)
    let deltaAeration = 0;
    let recommendedAeration = currentAeration;
    let odCoveredByAeration = 0;

    if (stillNeedsAfterRpm || currentRpm >= MAX_RPM) {
      const availableAerationHeadroom = Math.max(0, MAX_AERATION - currentAeration);
      const rawNeededAeration = Math.ceil(remainingDeficit / odGainPerAeration);
      let steppedNeededAeration = Math.max(5, Math.ceil(rawNeededAeration / 5) * 5);
      if (currentRpm >= MAX_RPM && currentOd >= 36 && currentOd < 37) {
        steppedNeededAeration = 5;
      } else if (currentRpm >= MAX_RPM && currentOd >= 35 && currentOd < 36) {
        steppedNeededAeration = 10;
      }
      deltaAeration = Math.min(availableAerationHeadroom, steppedNeededAeration);
      recommendedAeration = currentAeration + deltaAeration;
      odCoveredByAeration = deltaAeration * odGainPerAeration;
      remainingDeficit = Math.max(0, remainingDeficit - odCoveredByAeration);
    }

    // 3º PASSO: Pressão (0,600 -> 0,850 bar)
    let deltaPressure = 0;
    let recommendedPressure = currentPressure;
    let odCoveredByPressure = 0;
    const stillNeedsAfterAeration =
      (stillNeedsAfterRpm || currentRpm >= MAX_RPM) &&
      (recommendedAeration >= MAX_AERATION || currentAeration >= MAX_AERATION) &&
      remainingDeficit > 0.2;

    if (stillNeedsAfterAeration) {
      const availablePressureHeadroom = Math.max(0, MAX_PRESSURE - currentPressure);
      const rawSteps = Math.max(1, Math.ceil(remainingDeficit / (0.025 * odGainPerPressure)));
      let steppedNeededPressure = Number((rawSteps * 0.025).toFixed(3));
      if (currentOd >= 35 && currentOd < 37) {
        steppedNeededPressure = 0.025;
      }
      deltaPressure = Number(
        Math.min(availablePressureHeadroom, steppedNeededPressure).toFixed(3)
      );
      recommendedPressure = Number((currentPressure + deltaPressure).toFixed(3));
      odCoveredByPressure = deltaPressure * odGainPerPressure;
      remainingDeficit = Math.max(0, remainingDeficit - odCoveredByPressure);
    }

    const estimatedFinalOd = Number(
      Math.min(
        OD_MAX,
        Math.max(37, currentOd + odCoveredByRpm + odCoveredByAeration + odCoveredByPressure)
      ).toFixed(1)
    );

    const modePrefix = isPreventiveFineAdjustment ? 'AJUSTE LEVE RECOMENDADO' : 'CASCATA CORRETIVA';

    let activeStage: 'agitation' | 'aeration' | 'pressure' = 'agitation';
    let stageLabel = isPreventiveFineAdjustment
      ? 'Ajuste Leve · 1º Agitação (RPM)'
      : '1º Cascata · Agitação (RPM)';
    let operatorActionHeadline = `${modePrefix} (1º PASSO): SUBIR AGITAÇÃO EM +${deltaRpm} RPM (IR PARA ${recommendedRpm} RPM)`;

    if (deltaAeration > 0) {
      activeStage = 'aeration';
      stageLabel =
        deltaRpm > 0
          ? '1º Agitação + 2º Vazão de Ar'
          : isPreventiveFineAdjustment
          ? 'Ajuste Leve · 2º Vazão de Ar (L/min)'
          : '2º Cascata · Vazão de Ar (L/min)';
      operatorActionHeadline =
        deltaRpm > 0
          ? `1º SUBIR RPM ATÉ 230 + 2º SUBIR VAZÃO DE AR (+${deltaAeration} L/min)`
          : `${modePrefix} (2º PASSO · RPM MÁX): SUBIR VAZÃO DE AR EM +${deltaAeration} L/min (IR PARA ${recommendedAeration} L/min)`;
    }

    if (deltaPressure > 0 || (stillNeedsAfterAeration && currentAeration >= MAX_AERATION)) {
      activeStage = 'pressure';
      stageLabel = isPreventiveFineAdjustment
        ? 'Ajuste Leve · 3º Pressão (bar)'
        : '3º Cascata · Pressão (bar)';
      operatorActionHeadline = `${modePrefix} (3º PASSO): SUBIR PRESSÃO EM +${formatPressure(
        deltaPressure
      )} bar (IR PARA ${formatPressure(recommendedPressure)} bar)`;
    }

    return {
      isNominal: false,
      isPreventiveFineAdjustment,
      deficitOd: totalDeficit,
      activeStage,
      stageLabel,
      atRpmMax: recommendedRpm >= MAX_RPM,
      atAerationMax: recommendedAeration >= MAX_AERATION,
      atPressureMax: recommendedPressure >= MAX_PRESSURE,
      deltaRpm,
      recommendedRpm,
      deltaAeration,
      recommendedAeration,
      deltaPressure,
      recommendedPressure,
      isTempWithinBand,
      estimatedFinalOd,
      operatorActionHeadline,
    };
  }, [batch.odParams]);

  // Função central que aplica e SALVA no histórico de modificações com base no O2 e transmite na nuvem
  const applyAndLogO2Modification = (customTarget?: {
    newRpm?: number;
    newAeration?: number;
    newPressure?: number;
    newTemp?: number;
    customStageLabel?: string;
  }) => {
    const prevRpm = batch.odParams.currentRpm;
    const prevAeration = batch.odParams.currentAeration;
    const prevPressure = batch.odParams.currentPressure;
    const prevTemp = batch.odParams.currentTemp;
    const triggerOd = batch.odParams.currentOd;

    const newRpm = customTarget?.newRpm ?? cascadeCalculation.recommendedRpm;
    const newAeration = customTarget?.newAeration ?? cascadeCalculation.recommendedAeration;
    const newPressure = customTarget?.newPressure ?? cascadeCalculation.recommendedPressure;
    const newTemp = customTarget?.newTemp ?? prevTemp;

    const dRpm = newRpm - prevRpm;
    const dAer = newAeration - prevAeration;
    const dPress = Number((newPressure - prevPressure).toFixed(3));

    const parts: string[] = [];
    if (dRpm !== 0) {
      parts.push(`RPM: ${prevRpm} → ${newRpm} (${dRpm > 0 ? `+${dRpm}` : dRpm})`);
    }
    if (dAer !== 0) {
      parts.push(`Ar: ${prevAeration} → ${newAeration} L/min (${dAer > 0 ? `+${dAer}` : dAer})`);
    }
    if (dPress !== 0) {
      parts.push(
        `Pressão: ${formatPressure(prevPressure)} → ${formatPressure(newPressure)} bar (${
          dPress > 0 ? `+${formatPressure(dPress)}` : formatPressure(dPress)
        })`
      );
    }
    if (newTemp !== prevTemp) {
      parts.push(`Temp: ${prevTemp.toFixed(1)} → ${newTemp.toFixed(1)} °C`);
    }
    if (parts.length === 0) {
      parts.push(
        `Leitura O₂ ${triggerOd}% conferida — Mantidos ${newRpm} RPM, ${newAeration} L/min, ${formatPressure(
          newPressure
        )} bar`
      );
    }

    const nowClock = formatCurrentTimeWithSeconds();
    const nextOd = customTarget ? triggerOd : cascadeCalculation.estimatedFinalOd;

    const record: O2ModificationRecord = {
      id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: nowClock,
      cultivationElapsed: `T+ ${formatCountdownHms(batch.cultivationTracker.elapsedSeconds)}`,
      operatorName: batch.operatorName.trim() || 'Operador (Tablet)',
      triggerOd,
      estimatedOdAfter: nextOd,
      stageLabel: customTarget?.customStageLabel ?? cascadeCalculation.stageLabel,
      prevRpm,
      newRpm,
      deltaRpm: dRpm,
      prevAeration,
      newAeration,
      deltaAeration: dAer,
      prevPressure,
      newPressure,
      deltaPressure: dPress,
      prevTemp,
      newTemp,
      summary: parts.join(' · '),
      operatorNote: modificationReasonInput.trim() || '',
    };

    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        odParams: {
          currentOd: nextOd,
          referenceOd: Math.max(37, nextOd),
          currentRpm: newRpm,
          currentAeration: newAeration,
          currentPressure: newPressure,
          currentTemp: newTemp,
        },
        o2Modifications: [record, ...prev.o2Modifications].slice(0, 200),
      }),
      { immediateCloudPush: true }
    );

    setManualO2Input(String(nextOd).replace('.', ','));
    setModificationReasonInput('');
    setLastSavedBanner(
      `Sincronizado na nuvem às ${nowClock}: ${record.summary} (visível em todos os dispositivos)`
    );
    window.setTimeout(() => {
      setLastSavedBanner(null);
    }, 5000);
  };

  const deleteModificationRecord = (id: string) => {
    commitUserBatchUpdate(
      (prev) => ({
        ...prev,
        o2Modifications: prev.o2Modifications.filter((m) => m.id !== id),
      }),
      { immediateCloudPush: true }
    );
  };

  const resetToInitialParameters = () => {
    applyAndLogO2Modification({
      newRpm: PROCESS_LIMITS.INITIAL_RPM,
      newAeration: PROCESS_LIMITS.INITIAL_AERATION,
      newPressure: PROCESS_LIMITS.INITIAL_PRESSURE,
      newTemp: PROCESS_LIMITS.INITIAL_TEMP,
      customStageLabel: 'Restauração de Partida',
    });
  };

  const handleResetBatch = () => {
    const fresh: BatchState = {
      operatorName: batch.operatorName,
      batchNumber: '',
      tankId: batch.tankId,
      startedAt: formatCurrentDateTime(),
      generalNotes: '',
      odParams: DEFAULT_OD_PARAMS,
      cultivationTracker: DEFAULT_CULTIVATION_TRACKER,
      twoHourLogs: createDefaultTwoHourLogs(),
      o2Modifications: [],
      lastPersistedAt: formatCurrentTimeWithSeconds(),
      updatedAtMs: Date.now(),
    };
    latestBatchRef.current = fresh;
    setBatch(fresh);
    persistStateLocally(fresh);
    pushBatchToFirestore(fresh);
    setManualO2Input(String(DEFAULT_OD_PARAMS.currentOd));
    setShowResetConfirm(false);
  };

  const exportFullBackupJson = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(batch, null, 2));
    const link = document.createElement('a');
    link.setAttribute('href', dataStr);
    link.setAttribute('download', `Backup_BlueN_${batch.batchNumber || 'Batelada'}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportBackupJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(String(e.target?.result || '{}'));
        if (parsed && typeof parsed === 'object') {
          const hydrated = {
            ...hydrateParsedBatchState(parsed),
            updatedAtMs: Date.now(),
          };
          latestBatchRef.current = hydrated;
          setBatch(hydrated);
          persistStateLocally(hydrated);
          pushBatchToFirestore(hydrated);
          setManualO2Input(String(hydrated.odParams.currentOd).replace('.', ','));
          setLastSavedBanner('Backup restaurado e sincronizado na nuvem para todos os dispositivos!');
        }
      } catch {
        // ignore invalid json
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const exportTwoHourCsv = () => {
    const headers = [
      'Intervalo_Cultivo',
      'Status',
      'Horario_Registro',
      'O2_OD_%',
      'Agitacao_RPM',
      'Vazao_Ar_L_min',
      'Pressao_bar',
      'Temperatura_C',
      'Observacao',
    ];
    const rows = TWO_HOUR_SLOTS.map((hr) => {
      const r = batch.twoHourLogs[hr];
      return [
        `${hr}h`,
        r?.recorded ? 'Registrado' : 'Pendente',
        r?.recordedAt || '-',
        r?.recorded ? r.od : '-',
        r?.recorded ? r.rpm : '-',
        r?.recorded ? r.aeration : '-',
        r?.recorded ? formatPressure(r.pressure) : '-',
        r?.recorded ? r.temp.toFixed(1).replace('.', ',') : '-',
        `"${(r?.note || '').replace(/"/g, '""')}"`,
      ].join(';');
    });

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(';'), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Reporte_2h_BlueN_${batch.batchNumber || 'Lote'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportO2ModificationsCsv = () => {
    const headers = [
      'Horario',
      'Tempo_Cultivo',
      'Operador',
      'O2_Gatilho_%',
      'Etapa_Cascata',
      'RPM_Antes',
      'RPM_Depois',
      'Delta_RPM',
      'Ar_Antes_L_min',
      'Ar_Depois_L_min',
      'Delta_Ar',
      'Pressao_Antes_bar',
      'Pressao_Depois_bar',
      'Delta_Pressao',
      'Temp_C',
      'Resumo',
      'Observacao',
    ];
    const rows = batch.o2Modifications.map((m) =>
      [
        m.timestamp,
        m.cultivationElapsed,
        `"${m.operatorName.replace(/"/g, '""')}"`,
        String(m.triggerOd).replace('.', ','),
        `"${m.stageLabel}"`,
        m.prevRpm,
        m.newRpm,
        m.deltaRpm,
        m.prevAeration,
        m.newAeration,
        m.deltaAeration,
        formatPressure(m.prevPressure),
        formatPressure(m.newPressure),
        formatPressure(m.deltaPressure),
        m.newTemp.toFixed(1).replace('.', ','),
        `"${m.summary.replace(/"/g, '""')}"`,
        `"${(m.operatorNote || '').replace(/"/g, '""')}"`,
      ].join(';')
    );

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(';'), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Modificacoes_O2_BlueN_${batch.batchNumber || 'Lote'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const secondsUntilNext2hLog =
    TWO_HOURS_SECONDS - (batch.cultivationTracker.elapsedSeconds % TWO_HOURS_SECONDS);
  const recorded2hCount = TWO_HOUR_SLOTS.filter((hr) => batch.twoHourLogs[hr]?.recorded).length;

  // ==========================================================================
  // SÉRIES DE DADOS PARA OS GRÁFICOS (A CADA AJUSTE DE O2 E A CADA 2 HORAS)
  // ==========================================================================
  const chronologicalAdjustments = useMemo(() => {
    const reversed = [...batch.o2Modifications].reverse();
    const initialPoint = {
      label: 'Partida',
      sublabel: '0h',
      odTrigger: 37.0,
      odAfter: 37.0,
      rpm: PROCESS_LIMITS.INITIAL_RPM,
      aeration: PROCESS_LIMITS.INITIAL_AERATION,
      pressure: PROCESS_LIMITS.INITIAL_PRESSURE,
      temp: PROCESS_LIMITS.INITIAL_TEMP,
      note: 'Configuração inicial de partida (95 RPM · 50 L/min · 0,600 bar · 28 °C)',
    };

    const mapped = reversed.map((mod, idx) => ({
      label: `Aj. #${idx + 1}`,
      sublabel: mod.timestamp.slice(0, 5),
      odTrigger: mod.triggerOd,
      odAfter: mod.estimatedOdAfter,
      rpm: mod.newRpm,
      aeration: mod.newAeration,
      pressure: mod.newPressure,
      temp: mod.newTemp,
      note: `${mod.timestamp} (${mod.cultivationElapsed}) — ${mod.summary}`,
    }));

    if (mapped.length === 0) {
      return [
        initialPoint,
        {
          label: 'Atual',
          sublabel: 'Agora',
          odTrigger: batch.odParams.currentOd,
          odAfter: cascadeCalculation.estimatedFinalOd,
          rpm: batch.odParams.currentRpm,
          aeration: batch.odParams.currentAeration,
          pressure: batch.odParams.currentPressure,
          temp: batch.odParams.currentTemp,
          note: 'Leitura atual em tempo real no painel de controle',
        },
      ];
    }

    return [initialPoint, ...mapped];
  }, [batch.o2Modifications, batch.odParams, cascadeCalculation.estimatedFinalOd]);

  const recordedTwoHourSeries = useMemo(() => {
    const recordedSlots = TWO_HOUR_SLOTS.filter((hr) => batch.twoHourLogs[hr]?.recorded).map(
      (hr) => {
        const rec = batch.twoHourLogs[hr];
        return {
          label: `${hr}h`,
          sublabel: rec.recordedAt || '',
          od: rec.od,
          rpm: rec.rpm,
          aeration: rec.aeration,
          pressure: rec.pressure,
          temp: rec.temp,
          note: rec.note || `Reporte de ${hr}h de cultivo`,
        };
      }
    );

    if (recordedSlots.length === 1) {
      return [
        ...recordedSlots,
        {
          label: 'Atual',
          sublabel: formatCurrentTime(),
          od: batch.odParams.currentOd,
          rpm: batch.odParams.currentRpm,
          aeration: batch.odParams.currentAeration,
          pressure: batch.odParams.currentPressure,
          temp: batch.odParams.currentTemp,
          note: 'Leitura atual do reator',
        },
      ];
    }

    return recordedSlots;
  }, [batch.twoHourLogs, batch.odParams]);

  return (
    <div className="min-h-screen flex flex-col bg-[#090D16] text-slate-100 selection:bg-sky-500/30">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleImportBackupJson}
        className="hidden"
      />

      {/* =======================================================================
          HEADER CORPORATIVO SAAS COM SINCRONIZAÇÃO EM TEMPO REAL NA NUVEM
         ======================================================================= */}
      <header className="sticky top-0 z-30 bg-[#090D16]/95 backdrop-blur-md border-b border-slate-800/90 no-print">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          {/* Brand Wordmark + Indicador de Nuvem Ao Vivo */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="text-base font-bold tracking-tight text-white whitespace-nowrap flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-xs bg-sky-400" />
              <span>BlueN Control</span>
            </div>

            <button
              type="button"
              onClick={handleManualCloudSync}
              title="Clique para sincronizar imediatamente com a nuvem — todos os dispositivos no link veem a mesma tela"
              className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono cursor-pointer transition-colors ${
                cloudStatus === 'synced'
                  ? 'bg-emerald-950/60 border-emerald-600/50 text-emerald-300 hover:bg-emerald-900/60'
                  : cloudStatus === 'connecting'
                  ? 'bg-sky-950/60 border-sky-600/50 text-sky-300'
                  : 'bg-amber-950/60 border-amber-600/50 text-amber-300'
              }`}
            >
              <Cloud className="w-3.5 h-3.5 shrink-0" />
              <span>
                {cloudStatus === 'synced'
                  ? `Nuvem Ao Vivo (${lastCloudSyncTime})`
                  : cloudStatus === 'connecting'
                  ? 'Sincronizando...'
                  : 'Tentar Sincronizar'}
              </span>
              <RefreshCw className="w-3 h-3 ml-0.5 opacity-80" />
            </button>
          </div>

          {/* Seletor de Abas Principal: Operação vs Gráficos (Apenas Visualização) */}
          <div className="flex items-center bg-[#0F1624] p-1 rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab('operacao')}
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'operacao'
                  ? 'bg-sky-400 text-slate-950'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Operação (Tablet)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('graficos')}
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'graficos'
                  ? 'bg-sky-400 text-slate-950'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Gráficos (Visualização)</span>
            </button>
          </div>

          {/* Ações Rápidas: Compartilhar Link, Backup, Imprimir, Nova Batelada */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopySharedLink}
              title="Copiar link para acompanhar os ajustes do tablet em tempo real de qualquer dispositivo"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-600/50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden lg:inline">
                {copiedLinkNotice ? 'Link Copiado!' : 'Compartilhar Link'}
              </span>
            </button>

            <button
              type="button"
              onClick={exportFullBackupJson}
              title="Baixar cópia completa dos dados da batelada"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-sky-400" />
              <span className="hidden xl:inline">Backup</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Restaurar arquivo de backup JSON"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden xl:inline">Restaurar</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden sm:inline">Imprimir</span>
            </button>

            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Nova Batelada</span>
            </button>
          </div>
        </div>
      </header>

      {/* =======================================================================
          CORPO PRINCIPAL
         ======================================================================= */}
      <main id="topo" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* IDENTIFICAÇÃO OPERACIONAL E TELEMETRIA DE TEMPO DE CULTIVO */}
        <section
          aria-label="Identificação da Batelada"
          className="bg-[#0F1624] border border-slate-800/90 rounded-xl p-6 space-y-5"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-sky-400">
                <span>SINCRONIZAÇÃO EM TEMPO REAL (TODOS OS DISPOSITIVOS)</span>
                <span>·</span>
                <span>ESTÁVEL: 37% – 40%</span>
                <span>·</span>
                <span className="text-amber-300">AJUSTE LEVE IMEDIATO: 36% (+5 RPM) E 35% (+10 RPM)</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-1">
                {activeTab === 'operacao'
                  ? 'Controle de Parâmetros por O₂ Dissolvido & Rastreabilidade em Nuvem'
                  : 'Painel de Gráficos em Tempo Real — Evolução de O₂ e Parâmetros'}
              </h1>
            </div>

            {/* Cronômetro de Tempo de Cultivo integrado no cabeçalho */}
            <div className="flex flex-wrap items-center gap-3 bg-[#090D16] border border-slate-800 rounded-lg px-4 py-2.5">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400 block">
                  Tempo de Cultivo
                </span>
                <span className="text-lg font-mono tabular-nums font-bold text-emerald-400">
                  T+ {formatCountdownHms(batch.cultivationTracker.elapsedSeconds)}
                </span>
              </div>
              {activeTab === 'operacao' && (
                <div className="no-print">
                  {!batch.cultivationTracker.isRunning ? (
                    <button
                      type="button"
                      onClick={startCultivationTracker}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-md transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-slate-950" />
                      Iniciar Cultivo
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={pauseCultivationTracker}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-md transition-colors cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      Pausar
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="operator-name"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Operador Responsável (Tablet)
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="operator-name"
                  type="text"
                  maxLength={120}
                  readOnly={activeTab === 'graficos'}
                  value={batch.operatorName}
                  onChange={(e) =>
                    commitUserBatchUpdate((prev) => ({ ...prev, operatorName: e.target.value }))
                  }
                  placeholder="Nome ou matrícula"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-[#090D16] border border-slate-800 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-400 transition-colors"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="batch-number"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Código do Lote / Batelada
              </label>
              <div className="relative">
                <Hash className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="batch-number"
                  type="text"
                  maxLength={80}
                  readOnly={activeTab === 'graficos'}
                  value={batch.batchNumber}
                  onChange={(e) =>
                    commitUserBatchUpdate((prev) => ({ ...prev, batchNumber: e.target.value }))
                  }
                  placeholder="Ex: BLN-2026-042"
                  className="w-full pl-9 pr-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-400 transition-colors"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="tank-id"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Equipamento / Biorreator
              </label>
              <input
                id="tank-id"
                type="text"
                maxLength={80}
                readOnly={activeTab === 'graficos'}
                value={batch.tankId}
                onChange={(e) =>
                  commitUserBatchUpdate((prev) => ({ ...prev, tankId: e.target.value }))
                }
                placeholder="Ex: Reator BlueN-01"
                className="w-full px-3 py-2 text-sm bg-[#090D16] border border-slate-800 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-400 transition-colors"
              />
            </div>
          </div>
        </section>

        {/* =====================================================================
            ABA 2: GRÁFICOS DE PARÂMETROS (APENAS VISUALIZAÇÃO EM TEMPO REAL)
           ===================================================================== */}
        {activeTab === 'graficos' ? (
          <div className="space-y-8">
            <section className="bg-[#0F1624] border border-slate-800/90 rounded-xl p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="px-2.5 py-1 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 font-mono text-xs font-bold flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5" />
                    VISUALIZAÇÃO AO VIVO (SINCRONIZADO EM TODOS OS DISPOSITIVOS)
                  </span>
                  <span className="text-xs text-slate-400">
                    Qualquer ajuste salvo no tablet atualiza estes gráficos instantaneamente
                  </span>
                </div>

                <div className="flex items-center gap-1.5 bg-[#090D16] p-1 rounded-lg border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setChartSourceFilter('ambos')}
                    className={`px-3 py-1 text-xs font-semibold rounded transition-colors cursor-pointer ${
                      chartSourceFilter === 'ambos'
                        ? 'bg-sky-400 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Todos os Gráficos
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartSourceFilter('ajustes')}
                    className={`px-3 py-1 text-xs font-semibold rounded transition-colors cursor-pointer ${
                      chartSourceFilter === 'ajustes'
                        ? 'bg-sky-400 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    A cada Ajuste ({batch.o2Modifications.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartSourceFilter('2h')}
                    className={`px-3 py-1 text-xs font-semibold rounded transition-colors cursor-pointer ${
                      chartSourceFilter === '2h'
                        ? 'bg-sky-400 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    A cada 2h ({recorded2hCount}/{TWO_HOUR_SLOTS.length})
                  </button>
                </div>
              </div>

              {/* Cartões de Leitura Atual (Somente Leitura) */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono tabular-nums">
                <div className="bg-[#090D16] border border-slate-800 rounded-lg p-3">
                  <span className="text-[11px] text-slate-400 block">O₂ Dissolvido Atual</span>
                  <span
                    className={`text-xl font-bold ${
                      batch.odParams.currentOd >= 37 ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {String(batch.odParams.currentOd).replace('.', ',')}%
                  </span>
                  <span className="text-[10px] text-slate-500 block">Estável: 37% – 40%</span>
                </div>

                <div className="bg-[#090D16] border border-slate-800 rounded-lg p-3">
                  <span className="text-[11px] text-slate-400 block">1º Agitação Atual</span>
                  <span className="text-xl font-bold text-sky-400">
                    {batch.odParams.currentRpm} RPM
                  </span>
                  <span className="text-[10px] text-slate-500 block">Faixa: 95 → 230 RPM</span>
                </div>

                <div className="bg-[#090D16] border border-slate-800 rounded-lg p-3">
                  <span className="text-[11px] text-slate-400 block">2º Vazão de Ar Atual</span>
                  <span className="text-xl font-bold text-cyan-400">
                    {batch.odParams.currentAeration} L/min
                  </span>
                  <span className="text-[10px] text-slate-500 block">Faixa: 50 → 200 L/min</span>
                </div>

                <div className="bg-[#090D16] border border-slate-800 rounded-lg p-3">
                  <span className="text-[11px] text-slate-400 block">3º Pressão Atual</span>
                  <span className="text-xl font-bold text-indigo-400">
                    {formatPressure(batch.odParams.currentPressure)} bar
                  </span>
                  <span className="text-[10px] text-slate-500 block">
                    Faixa: 0,600 → 0,850 bar
                  </span>
                </div>

                <div className="bg-[#090D16] border border-slate-800 rounded-lg p-3 col-span-2 sm:col-span-1">
                  <span className="text-[11px] text-slate-400 block">Temperatura Atual</span>
                  <span className="text-xl font-bold text-amber-400">
                    {batch.odParams.currentTemp.toFixed(1).replace('.', ',')} °C
                  </span>
                  <span className="text-[10px] text-slate-500 block">Faixa: 28,0 → 29,0 °C</span>
                </div>
              </div>
            </section>

            {/* BLOCO A: GRÁFICOS A CADA AJUSTE DE O₂ */}
            {(chartSourceFilter === 'ambos' || chartSourceFilter === 'ajustes') && (
              <section className="bg-[#0F1624] border border-slate-800/90 rounded-xl overflow-hidden">
                <div className="bg-[#131C2E] border-b border-slate-800 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-400 font-mono text-xs font-bold flex items-center justify-center">
                      A
                    </span>
                    <div>
                      <h2 className="text-base font-bold text-white flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-sky-400" />
                        <span>
                          GRÁFICOS A CADA AJUSTE REALIZADO COM BASE NO O₂ (
                          {batch.o2Modifications.length} ajustes registrados)
                        </span>
                      </h2>
                      <p className="text-xs text-slate-400">
                        Evolução da porcentagem de O₂ e de todos os parâmetros do biorreator a cada
                        intervenção registrada no histórico
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-5">
                  <TelemetryLineChart
                    title="Porcentagem de O₂ Dissolvido a cada Ajuste (%)"
                    subtitle="Linha sólida: O₂ lido que motivou o ajuste · Linha tracejada verde: O₂ estimado após o ajuste"
                    unit="%"
                    yMin={0}
                    yMax={55}
                    strokeColor="#38bdf8"
                    fillGradientId="grad_o2_adjustments"
                    secondaryLabel="O₂ Estimado Pós-Ajuste"
                    secondaryColor="#34d399"
                    targetBand={{ min: 35, max: 40, label: 'META OPERACIONAL O₂ (35% – 40%)' }}
                    height={270}
                    data={chronologicalAdjustments.map((item) => ({
                      label: item.label,
                      sublabel: item.sublabel,
                      value: item.odTrigger,
                      secondaryValue: item.odAfter,
                      note: item.note,
                    }))}
                  />

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <TelemetryLineChart
                      title="1º Agitação a cada Ajuste (RPM)"
                      subtitle="Evolução da rotação do agitador a cada ajuste de O₂ (Início: 95 RPM · Limite: 230 RPM)"
                      unit="RPM"
                      yMin={70}
                      yMax={250}
                      strokeColor="#60a5fa"
                      fillGradientId="grad_rpm_adjustments"
                      initialLine={{ value: 95, label: 'Partida 95 RPM' }}
                      limitLine={{ value: 230, label: 'LIMITE MÁXIMO 230 RPM', color: '#f59e0b' }}
                      data={chronologicalAdjustments.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.rpm,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="2º Vazão de Ar a cada Ajuste (L/min)"
                      subtitle="Evolução da aeração a cada ajuste de O₂ (Início: 50 L/min · Limite: 200 L/min)"
                      unit="L/min"
                      yMin={30}
                      yMax={220}
                      strokeColor="#22d3ee"
                      fillGradientId="grad_air_adjustments"
                      initialLine={{ value: 50, label: 'Partida 50 L/min' }}
                      limitLine={{ value: 200, label: 'LIMITE MÁXIMO 200 L/min', color: '#f59e0b' }}
                      data={chronologicalAdjustments.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.aeration,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="3º Pressão a cada Ajuste (bar)"
                      subtitle="Evolução da pressão do vaso a cada ajuste de O₂ (Início: 0,600 bar · Limite: 0,850 bar)"
                      unit="bar"
                      yMin={0.5}
                      yMax={0.92}
                      strokeColor="#818cf8"
                      fillGradientId="grad_pressure_adjustments"
                      initialLine={{ value: 0.6, label: 'Partida 0,600 bar' }}
                      limitLine={{
                        value: 0.85,
                        label: 'LIMITE MÁXIMO 0,850 bar',
                        color: '#f59e0b',
                      }}
                      formatValue={(v) => formatPressure(v)}
                      data={chronologicalAdjustments.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.pressure,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="Temperatura a cada Ajuste (°C)"
                      subtitle="Monitoramento térmico do cultivo durante os ajustes (Faixa: 28,0 °C a 29,0 °C)"
                      unit="°C"
                      yMin={26}
                      yMax={31}
                      strokeColor="#fbbf24"
                      fillGradientId="grad_temp_adjustments"
                      targetBand={{ min: 28.0, max: 29.0, label: 'FAIXA TÉRMICA (28,0 – 29,0 °C)' }}
                      formatValue={(v) => v.toFixed(1).replace('.', ',')}
                      data={chronologicalAdjustments.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.temp,
                        note: item.note,
                      }))}
                    />
                  </div>
                </div>
              </section>
            )}

            {/* BLOCO B: GRÁFICOS A CADA 2 HORAS (0h ATÉ 24h) */}
            {(chartSourceFilter === 'ambos' || chartSourceFilter === '2h') && (
              <section className="bg-[#0F1624] border border-slate-800/90 rounded-xl overflow-hidden">
                <div className="bg-[#131C2E] border-b border-slate-800 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center">
                      B
                    </span>
                    <div>
                      <h2 className="text-base font-bold text-white flex items-center gap-2">
                        <Clock className="w-4 h-4 text-emerald-400" />
                        <span>
                          GRÁFICOS DO REPORTE A CADA 2 HORAS (0h ATÉ 24h · {recorded2hCount}{' '}
                          horários registrados)
                        </span>
                      </h2>
                      <p className="text-xs text-slate-400">
                        Curva periódica de 2 em 2 horas da porcentagem de O₂ e de todos os demais
                        parâmetros do cultivo
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-5">
                  <TelemetryLineChart
                    title="Porcentagem de O₂ Dissolvido a cada 2 Horas (0h – 24h)"
                    subtitle="Acompanhamento periódico de O₂ (%) registrado nas janelas de 2 em 2 horas"
                    unit="%"
                    yMin={0}
                    yMax={55}
                    strokeColor="#10b981"
                    fillGradientId="grad_o2_2h"
                    targetBand={{ min: 35, max: 40, label: 'META OPERACIONAL O₂ (35% – 40%)' }}
                    height={270}
                    data={recordedTwoHourSeries.map((item) => ({
                      label: item.label,
                      sublabel: item.sublabel,
                      value: item.od,
                      note: item.note,
                    }))}
                  />

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <TelemetryLineChart
                      title="1º Agitação a cada 2 Horas (RPM)"
                      subtitle="Curva de RPM ao longo das janelas de 2h (Partida: 95 RPM · Máx: 230 RPM)"
                      unit="RPM"
                      yMin={70}
                      yMax={250}
                      strokeColor="#38bdf8"
                      fillGradientId="grad_rpm_2h"
                      initialLine={{ value: 95, label: 'Partida 95 RPM' }}
                      limitLine={{ value: 230, label: 'LIMITE MÁXIMO 230 RPM', color: '#f59e0b' }}
                      data={recordedTwoHourSeries.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.rpm,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="2º Vazão de Ar a cada 2 Horas (L/min)"
                      subtitle="Curva de Vazão de Ar ao longo das janelas de 2h (Partida: 50 L/min · Máx: 200 L/min)"
                      unit="L/min"
                      yMin={30}
                      yMax={220}
                      strokeColor="#06b6d4"
                      fillGradientId="grad_air_2h"
                      initialLine={{ value: 50, label: 'Partida 50 L/min' }}
                      limitLine={{ value: 200, label: 'LIMITE MÁXIMO 200 L/min', color: '#f59e0b' }}
                      data={recordedTwoHourSeries.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.aeration,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="3º Pressão a cada 2 Horas (bar)"
                      subtitle="Curva de Pressão do biorreator a cada 2h (Partida: 0,600 bar · Máx: 0,850 bar)"
                      unit="bar"
                      yMin={0.5}
                      yMax={0.92}
                      strokeColor="#a78bfa"
                      fillGradientId="grad_pressure_2h"
                      initialLine={{ value: 0.6, label: 'Partida 0,600 bar' }}
                      limitLine={{
                        value: 0.85,
                        label: 'LIMITE MÁXIMO 0,850 bar',
                        color: '#f59e0b',
                      }}
                      formatValue={(v) => formatPressure(v)}
                      data={recordedTwoHourSeries.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.pressure,
                        note: item.note,
                      }))}
                    />

                    <TelemetryLineChart
                      title="Temperatura a cada 2 Horas (°C)"
                      subtitle="Curva de Temperatura a cada 2h (Partida: 28,0 °C · Limite: 29,0 °C)"
                      unit="°C"
                      yMin={26}
                      yMax={31}
                      strokeColor="#f59e0b"
                      fillGradientId="grad_temp_2h"
                      targetBand={{ min: 28.0, max: 29.0, label: 'FAIXA TÉRMICA (28,0 – 29,0 °C)' }}
                      formatValue={(v) => v.toFixed(1).replace('.', ',')}
                      data={recordedTwoHourSeries.map((item) => ({
                        label: item.label,
                        sublabel: item.sublabel,
                        value: item.temp,
                        note: item.note,
                      }))}
                    />
                  </div>
                </div>
              </section>
            )}
          </div>
        ) : (
          /* ===================================================================
              ABA 1: OPERAÇÃO & CONTROLE DE PARÂMETROS COM BASE NO O₂
             =================================================================== */
          <>
            {/* SEÇÃO 1: CONTROLE EM CASCATA DE PARÂMETROS COM BASE NO O₂ DISSOLVIDO */}
            <section
              id="controle-od"
              className="bg-[#0F1624] border border-slate-800/90 rounded-xl overflow-hidden"
            >
              <div className="bg-[#131C2E] border-b border-slate-800 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-400 font-mono text-xs font-bold flex items-center justify-center">
                    01
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-white">
                      CONTROLE DE PARÂMETROS COM BASE NO OXIGÊNIO DISSOLVIDO (O₂)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Com 36% já recomenda ajuste leve (+5 RPM) e com 35% ajuste preventivo (+10
                      RPM) · Sincronizado em todos os dispositivos
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 no-print">
                  <button
                    type="button"
                    onClick={() => setActiveTab('graficos')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 rounded-md border border-sky-500/40 transition-colors cursor-pointer"
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                    Ver Gráficos de O₂ e Parâmetros
                  </button>
                  <button
                    type="button"
                    onClick={resetToInitialParameters}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Restaurar Partida
                  </button>
                </div>
              </div>

              <div className="p-6 space-y-5">
                {lastSavedBanner && (
                  <div className="bg-emerald-950/60 border border-emerald-500/70 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-emerald-300">
                    <span>✓ {lastSavedBanner}</span>
                    <div className="flex items-center gap-4">
                      <a
                        href="#historico-modificacoes-o2"
                        className="underline font-bold text-emerald-200 whitespace-nowrap"
                      >
                        Ver na Tabela ↓
                      </a>
                      <button
                        type="button"
                        onClick={() => setActiveTab('graficos')}
                        className="underline font-bold text-sky-300 whitespace-nowrap cursor-pointer"
                      >
                        Ver nos Gráficos →
                      </button>
                    </div>
                  </div>
                )}

                {/* Linha Superior: Input Manual de O2 + Comando Direto Lado a Lado */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
                  {/* Entrada Manual de O2 */}
                  <div className="lg:col-span-5 bg-[#090D16] border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="manual-o2-field"
                        className="text-xs font-mono uppercase font-semibold text-sky-400 flex items-center gap-1.5"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                        Leitura Atual de O₂ Dissolvido (%)
                      </label>
                      <span className="text-xs font-mono text-emerald-400">
                        Estável: ≥ 37% · Ajuste Leve: 36%
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = Math.max(
                            0,
                            Number((batch.odParams.currentOd - 1).toFixed(1))
                          );
                          updateOdParam('currentOd', next, true);
                          setManualO2Input(String(next).replace('.', ','));
                        }}
                        className="w-10 h-11 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-white font-mono text-lg font-bold cursor-pointer shrink-0"
                      >
                        -
                      </button>

                      <div className="relative flex-1">
                        <input
                          id="manual-o2-field"
                          type="text"
                          inputMode="decimal"
                          value={manualO2Input}
                          onChange={(e) => handleManualO2TextChange(e.target.value)}
                          placeholder="36"
                          className="w-full text-2xl sm:text-3xl font-mono tabular-nums font-bold text-white bg-[#111827] border border-sky-500/60 rounded-lg py-1.5 pl-3 pr-10 text-center focus:outline-none focus:border-sky-400"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-mono font-bold text-sky-400 pointer-events-none">
                          %
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const next = Math.min(
                            100,
                            Number((batch.odParams.currentOd + 1).toFixed(1))
                          );
                          updateOdParam('currentOd', next, true);
                          setManualO2Input(String(next).replace('.', ','));
                        }}
                        className="w-10 h-11 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-white font-mono text-lg font-bold cursor-pointer shrink-0"
                      >
                        +
                      </button>
                    </div>

                    <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 pt-1">
                      {[25, 30, 34, 35, 36, 37, 38, 40].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => {
                            updateOdParam('currentOd', val, true);
                            setManualO2Input(String(val));
                          }}
                          className={`py-1 text-xs font-mono tabular-nums font-semibold rounded border transition-colors cursor-pointer ${
                            batch.odParams.currentOd === val
                              ? 'bg-sky-400 text-slate-950 border-sky-400'
                              : val === 35 || val === 36
                              ? 'bg-amber-950/40 text-amber-300 border-amber-500/40 hover:bg-amber-900/50'
                              : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-slate-200'
                          }`}
                        >
                          {val}%
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Comando Calculado Imediato + Botão de Salvar Modificação no Histórico */}
                  <div
                    className={`lg:col-span-7 rounded-xl border p-4 flex flex-col justify-between gap-3 ${
                      cascadeCalculation.isNominal
                        ? 'bg-emerald-950/25 border-emerald-600/50'
                        : cascadeCalculation.isPreventiveFineAdjustment
                        ? 'bg-amber-950/25 border-amber-500/60'
                        : 'bg-sky-950/25 border-sky-500/50'
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`text-xs font-mono uppercase font-semibold ${
                            cascadeCalculation.isNominal
                              ? 'text-emerald-400'
                              : cascadeCalculation.isPreventiveFineAdjustment
                              ? 'text-amber-300'
                              : 'text-sky-300'
                          }`}
                        >
                          {cascadeCalculation.isNominal
                            ? '✓ ESTÁVEL (O₂ ≥ 37%) · NENHUM AJUSTE NECESSÁRIO'
                            : cascadeCalculation.isPreventiveFineAdjustment
                            ? `▲ O₂ EM ${batch.odParams.currentOd}% · AJUSTE LEVE PREVENTIVO IMEDIATO`
                            : `▲ DÉFICIT CORRETIVO (+${cascadeCalculation.deficitOd}% O₂) · AÇÃO EM CASCATA`}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          1º RPM → 2º Ar → 3º Pressão
                        </span>
                      </div>

                      <div className="text-base sm:text-lg font-bold text-white">
                        {cascadeCalculation.operatorActionHeadline}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {cascadeCalculation.deltaRpm > 0 && (
                          <span className="px-2.5 py-1 rounded bg-[#090D16] border border-sky-500/50 font-mono text-xs font-semibold text-sky-300">
                            1º Agitação: +{cascadeCalculation.deltaRpm} RPM (
                            {batch.odParams.currentRpm} → {cascadeCalculation.recommendedRpm} RPM)
                          </span>
                        )}
                        {cascadeCalculation.deltaAeration > 0 && (
                          <span className="px-2.5 py-1 rounded bg-[#090D16] border border-sky-500/50 font-mono text-xs font-semibold text-sky-300">
                            2º Ar: +{cascadeCalculation.deltaAeration} L/min (
                            {batch.odParams.currentAeration} →{' '}
                            {cascadeCalculation.recommendedAeration} L/min)
                          </span>
                        )}
                        {cascadeCalculation.deltaPressure > 0 && (
                          <span className="px-2.5 py-1 rounded bg-[#090D16] border border-sky-500/50 font-mono text-xs font-semibold text-sky-300">
                            3º Pressão: +{formatPressure(cascadeCalculation.deltaPressure)} bar (
                            {formatPressure(batch.odParams.currentPressure)} →{' '}
                            {formatPressure(cascadeCalculation.recommendedPressure)} bar)
                          </span>
                        )}
                        {cascadeCalculation.isNominal && (
                          <span className="px-2.5 py-1 rounded bg-[#090D16] border border-emerald-700/50 font-mono text-xs text-emerald-300">
                            Parâmetros dentro da zona ideal (37%–40%)
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2.5 border-t border-slate-800/80 no-print">
                      <input
                        type="text"
                        maxLength={200}
                        value={modificationReasonInput}
                        onChange={(e) => setModificationReasonInput(e.target.value)}
                        placeholder="Nota opcional desta modificação (ex: ajuste leve em 36% O₂)..."
                        className="flex-1 px-3 py-1.5 text-xs bg-[#090D16] border border-slate-800 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                      />

                      <button
                        type="button"
                        onClick={() => applyAndLogO2Modification()}
                        className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          cascadeCalculation.isNominal
                            ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                            : cascadeCalculation.isPreventiveFineAdjustment
                            ? 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                            : 'bg-sky-400 hover:bg-sky-300 text-slate-950'
                        }`}
                      >
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                        {cascadeCalculation.isNominal
                          ? 'Registrar Verificação no Histórico'
                          : 'Aplicar e Salvar Modificação por O₂'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 4 Cartões Unificados (Valor Atual + Ajuste no Mesmo Cartão) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                  {/* 1. Agitação */}
                  <div
                    className={`rounded-xl border p-4 flex flex-col justify-between space-y-3 ${
                      cascadeCalculation.deltaRpm > 0
                        ? 'bg-[#090D16] border-sky-400'
                        : 'bg-[#090D16] border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Gauge className="w-3.5 h-3.5 text-sky-400" />
                        1º Agitação
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">95 → 230 RPM</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam('currentRpm', batch.odParams.currentRpm - 5, true)
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        -5
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={PROCESS_LIMITS.MAX_RPM}
                        step={5}
                        value={batch.odParams.currentRpm}
                        onChange={(e) => updateOdParam('currentRpm', parseFloat(e.target.value))}
                        className="w-full px-2 py-1.5 text-center text-base font-mono tabular-nums font-bold bg-[#111827] border border-slate-700 rounded text-white focus:outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam('currentRpm', batch.odParams.currentRpm + 5, true)
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        +5
                      </button>
                      <button
                        type="button"
                        onClick={() => updateOdParam('currentRpm', PROCESS_LIMITS.MAX_RPM, true)}
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-mono text-xs font-semibold cursor-pointer"
                      >
                        Máx
                      </button>
                    </div>

                    <div
                      className={`rounded-lg p-2.5 border text-xs font-mono flex items-center justify-between ${
                        cascadeCalculation.deltaRpm > 0
                          ? 'bg-sky-950/50 border-sky-500/50 text-sky-300'
                          : 'bg-slate-900/70 border-slate-800 text-slate-400'
                      }`}
                    >
                      {cascadeCalculation.deltaRpm > 0 ? (
                        <>
                          <span>
                            Subir <strong>+{cascadeCalculation.deltaRpm}</strong> →{' '}
                            {cascadeCalculation.recommendedRpm} RPM
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              applyAndLogO2Modification({
                                newRpm: cascadeCalculation.recommendedRpm,
                                newAeration: batch.odParams.currentAeration,
                                newPressure: batch.odParams.currentPressure,
                                customStageLabel: '1º Cascata · Agitação (RPM)',
                              })
                            }
                            className="px-2 py-0.5 bg-sky-400 text-slate-950 font-bold rounded cursor-pointer"
                          >
                            Salvar
                          </button>
                        </>
                      ) : batch.odParams.currentRpm >= PROCESS_LIMITS.MAX_RPM ? (
                        <span className="text-amber-300">Limite Máx (230 RPM)</span>
                      ) : (
                        <span className="text-emerald-400">
                          ✓ Manter ({batch.odParams.currentRpm} RPM)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 2. Vazão de Ar */}
                  <div
                    className={`rounded-xl border p-4 flex flex-col justify-between space-y-3 ${
                      cascadeCalculation.deltaAeration > 0
                        ? 'bg-[#090D16] border-sky-400'
                        : 'bg-[#090D16] border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Wind className="w-3.5 h-3.5 text-sky-400" />
                        2º Vazão de Ar
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">50 → 200 L/min</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentAeration',
                            batch.odParams.currentAeration - 5,
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        -5
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={PROCESS_LIMITS.MAX_AERATION}
                        step={5}
                        value={batch.odParams.currentAeration}
                        onChange={(e) =>
                          updateOdParam('currentAeration', parseFloat(e.target.value))
                        }
                        className="w-full px-2 py-1.5 text-center text-base font-mono tabular-nums font-bold bg-[#111827] border border-slate-700 rounded text-white focus:outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentAeration',
                            batch.odParams.currentAeration + 5,
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        +5
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam('currentAeration', PROCESS_LIMITS.MAX_AERATION, true)
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-mono text-xs font-semibold cursor-pointer"
                      >
                        Máx
                      </button>
                    </div>

                    <div
                      className={`rounded-lg p-2.5 border text-xs font-mono flex items-center justify-between ${
                        cascadeCalculation.deltaAeration > 0
                          ? 'bg-sky-950/50 border-sky-500/50 text-sky-300'
                          : 'bg-slate-900/70 border-slate-800 text-slate-400'
                      }`}
                    >
                      {cascadeCalculation.deltaAeration > 0 ? (
                        <>
                          <span>
                            Subir <strong>+{cascadeCalculation.deltaAeration}</strong> →{' '}
                            {cascadeCalculation.recommendedAeration} L/min
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              applyAndLogO2Modification({
                                newRpm: batch.odParams.currentRpm,
                                newAeration: cascadeCalculation.recommendedAeration,
                                newPressure: batch.odParams.currentPressure,
                                customStageLabel: '2º Cascata · Vazão de Ar (L/min)',
                              })
                            }
                            className="px-2 py-0.5 bg-sky-400 text-slate-950 font-bold rounded cursor-pointer"
                          >
                            Salvar
                          </button>
                        </>
                      ) : batch.odParams.currentAeration >= PROCESS_LIMITS.MAX_AERATION ? (
                        <span className="text-amber-300">Limite Máx (200 L/min)</span>
                      ) : (
                        <span className="text-emerald-400">
                          ✓ Manter ({batch.odParams.currentAeration} L/min)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 3. Pressão */}
                  <div
                    className={`rounded-xl border p-4 flex flex-col justify-between space-y-3 ${
                      cascadeCalculation.deltaPressure > 0
                        ? 'bg-[#090D16] border-sky-400'
                        : 'bg-[#090D16] border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-sky-400" />
                        3º Pressão
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        0,600 → 0,850 bar
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentPressure',
                            Number((batch.odParams.currentPressure - 0.025).toFixed(3)),
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        -0,025
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={PROCESS_LIMITS.MAX_PRESSURE}
                        step={0.025}
                        value={batch.odParams.currentPressure}
                        onChange={(e) =>
                          updateOdParam('currentPressure', parseFloat(e.target.value))
                        }
                        className="w-full px-2 py-1.5 text-center text-base font-mono tabular-nums font-bold bg-[#111827] border border-slate-700 rounded text-white focus:outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentPressure',
                            Number((batch.odParams.currentPressure + 0.025).toFixed(3)),
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        +0,025
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam('currentPressure', PROCESS_LIMITS.MAX_PRESSURE, true)
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-mono text-xs font-semibold cursor-pointer"
                      >
                        Máx
                      </button>
                    </div>

                    <div
                      className={`rounded-lg p-2.5 border text-xs font-mono flex items-center justify-between ${
                        cascadeCalculation.deltaPressure > 0
                          ? 'bg-sky-950/50 border-sky-500/50 text-sky-300'
                          : 'bg-slate-900/70 border-slate-800 text-slate-400'
                      }`}
                    >
                      {cascadeCalculation.deltaPressure > 0 ? (
                        <>
                          <span>
                            Subir{' '}
                            <strong>+{formatPressure(cascadeCalculation.deltaPressure)}</strong> →{' '}
                            {formatPressure(cascadeCalculation.recommendedPressure)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              applyAndLogO2Modification({
                                newRpm: batch.odParams.currentRpm,
                                newAeration: batch.odParams.currentAeration,
                                newPressure: cascadeCalculation.recommendedPressure,
                                customStageLabel: '3º Cascata · Pressão (bar)',
                              })
                            }
                            className="px-2 py-0.5 bg-sky-400 text-slate-950 font-bold rounded cursor-pointer"
                          >
                            Salvar
                          </button>
                        </>
                      ) : batch.odParams.currentPressure >= PROCESS_LIMITS.MAX_PRESSURE ? (
                        <span className="text-amber-300">Limite Máx (0,850 bar)</span>
                      ) : (
                        <span className="text-emerald-400">
                          ✓ Manter ({formatPressure(batch.odParams.currentPressure)} bar)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 4. Temperatura */}
                  <div
                    className={`rounded-xl border p-4 flex flex-col justify-between space-y-3 ${
                      !cascadeCalculation.isTempWithinBand
                        ? 'bg-[#090D16] border-amber-400'
                        : 'bg-[#090D16] border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Thermometer className="w-3.5 h-3.5 text-sky-400" />
                        Temperatura
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">28 → 29 °C</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentTemp',
                            Number((batch.odParams.currentTemp - 0.5).toFixed(1)),
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        -0,5
                      </button>
                      <input
                        type="number"
                        min={15}
                        max={45}
                        step={0.5}
                        value={batch.odParams.currentTemp}
                        onChange={(e) => updateOdParam('currentTemp', parseFloat(e.target.value))}
                        className="w-full px-2 py-1.5 text-center text-base font-mono tabular-nums font-bold bg-[#111827] border border-slate-700 rounded text-white focus:outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam(
                            'currentTemp',
                            Number((batch.odParams.currentTemp + 0.5).toFixed(1)),
                            true
                          )
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-semibold cursor-pointer"
                      >
                        +0,5
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateOdParam('currentTemp', PROCESS_LIMITS.INITIAL_TEMP, true)
                        }
                        className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 font-mono text-xs font-semibold cursor-pointer"
                      >
                        28°
                      </button>
                    </div>

                    <div
                      className={`rounded-lg p-2.5 border text-xs font-mono flex items-center justify-between ${
                        !cascadeCalculation.isTempWithinBand
                          ? 'bg-amber-950/50 border-amber-500/50 text-amber-300'
                          : 'bg-slate-900/70 border-slate-800 text-emerald-400'
                      }`}
                    >
                      {cascadeCalculation.isTempWithinBand ? (
                        <span>
                          ✓ Estável ({batch.odParams.currentTemp.toFixed(1).replace('.', ',')} °C)
                        </span>
                      ) : (
                        <>
                          <span>Ajustar p/ 28–29 °C</span>
                          <button
                            type="button"
                            onClick={() =>
                              applyAndLogO2Modification({
                                newRpm: batch.odParams.currentRpm,
                                newAeration: batch.odParams.currentAeration,
                                newPressure: batch.odParams.currentPressure,
                                newTemp: PROCESS_LIMITS.INITIAL_TEMP,
                                customStageLabel: 'Ajuste Térmico (28 °C)',
                              })
                            }
                            className="px-2 py-0.5 bg-amber-400 text-slate-950 font-bold rounded cursor-pointer"
                          >
                            Salvar
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Regra da Cascata em 1 Linha */}
                <div className="bg-[#090D16] border border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-slate-400 font-sans font-medium">
                    Prioridade de Cascata (a partir de O₂ ≤ 36%):
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`px-2.5 py-1 rounded font-semibold ${
                        !cascadeCalculation.isNominal &&
                        cascadeCalculation.activeStage === 'agitation'
                          ? 'bg-sky-400 text-slate-950'
                          : 'bg-slate-900 text-slate-300 border border-slate-800'
                      }`}
                    >
                      1º Subir RPM (95 → 230)
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    <span
                      className={`px-2.5 py-1 rounded font-semibold ${
                        !cascadeCalculation.isNominal &&
                        cascadeCalculation.activeStage === 'aeration'
                          ? 'bg-sky-400 text-slate-950'
                          : 'bg-slate-900 text-slate-300 border border-slate-800'
                      }`}
                    >
                      2º Subir Ar (50 → 200 L/min)
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    <span
                      className={`px-2.5 py-1 rounded font-semibold ${
                        !cascadeCalculation.isNominal &&
                        cascadeCalculation.activeStage === 'pressure'
                          ? 'bg-sky-400 text-slate-950'
                          : 'bg-slate-900 text-slate-300 border border-slate-800'
                      }`}
                    >
                      3º Subir Pressão (0,600 → 0,850 bar)
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* SEÇÃO 2: HISTÓRICO DE MODIFICAÇÕES REALIZADAS COM BASE NO O₂ */}
            <section
              id="historico-modificacoes-o2"
              className="bg-[#0F1624] border border-slate-800/90 rounded-xl overflow-hidden"
            >
              <div className="bg-[#131C2E] border-b border-slate-800 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-400 font-mono text-xs font-bold flex items-center justify-center">
                    02
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-white flex items-center gap-2">
                      <span>HISTÓRICO DE MODIFICAÇÕES COM BASE NO O₂</span>
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                        {batch.o2Modifications.length} registros
                      </span>
                    </h2>
                    <p className="text-xs text-slate-400">
                      Sincronizado em tempo real para todos os dispositivos conectados ao link
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 no-print">
                  <button
                    type="button"
                    onClick={() =>
                      applyAndLogO2Modification({
                        newRpm: batch.odParams.currentRpm,
                        newAeration: batch.odParams.currentAeration,
                        newPressure: batch.odParams.currentPressure,
                        newTemp: batch.odParams.currentTemp,
                        customStageLabel: 'Registro Manual de Estado Atual',
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-md transition-colors cursor-pointer"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    Gravar Parâmetros Atuais no Histórico
                  </button>

                  {batch.o2Modifications.length > 0 && (
                    <button
                      type="button"
                      onClick={exportO2ModificationsCsv}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Exportar Modificações (CSV)
                    </button>
                  )}
                </div>
              </div>

              <div className="p-6">
                {batch.o2Modifications.length === 0 ? (
                  <div className="bg-[#090D16] border border-slate-800/90 rounded-xl p-8 text-center space-y-2">
                    <History className="w-7 h-7 text-slate-500 mx-auto" />
                    <p className="text-sm font-semibold text-slate-300">
                      Nenhuma modificação por O₂ registrada ainda nesta batelada.
                    </p>
                    <p className="text-xs text-slate-500 max-w-lg mx-auto">
                      Sempre que o operador no tablet digitar o valor de O₂ e clicar em{' '}
                      <strong className="text-slate-300">
                        &quot;Aplicar e Salvar Modificação por O₂&quot;
                      </strong>
                      , o ajuste aparecerá imediatamente aqui e nos gráficos para todos que
                      acessarem o link.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-800/90 rounded-xl bg-[#090D16]">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-[#0B101B] border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400">
                          <th className="py-3 px-4">Horário / Cultivo</th>
                          <th className="py-3 px-3 text-right">O₂ Lido (%)</th>
                          <th className="py-3 px-3">Etapa Acionada</th>
                          <th className="py-3 px-3 text-right">Agitação (RPM)</th>
                          <th className="py-3 px-3 text-right">Vazão Ar (L/min)</th>
                          <th className="py-3 px-3 text-right">Pressão (bar)</th>
                          <th className="py-3 px-4">Resumo / Nota</th>
                          <th className="py-3 px-3 text-right no-print">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                        {batch.o2Modifications.map((mod) => (
                          <tr key={mod.id} className="hover:bg-slate-900/60 transition-colors">
                            <td className="py-3 px-4 whitespace-nowrap">
                              <div className="font-bold text-white">{mod.timestamp}</div>
                              <div className="text-[11px] text-slate-400">
                                {mod.cultivationElapsed} · {mod.operatorName}
                              </div>
                            </td>

                            <td className="py-3 px-3 text-right">
                              <span
                                className={`inline-block font-bold px-2 py-0.5 rounded ${
                                  mod.triggerOd < 37
                                    ? 'bg-amber-950/80 text-amber-300 border border-amber-500/40'
                                    : 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/40'
                                }`}
                              >
                                {mod.triggerOd}%
                              </span>
                            </td>

                            <td className="py-3 px-3 font-sans font-semibold text-sky-300 whitespace-nowrap">
                              {mod.stageLabel}
                            </td>

                            <td className="py-3 px-3 text-right whitespace-nowrap">
                              {mod.deltaRpm !== 0 ? (
                                <div>
                                  <span className="text-slate-400">{mod.prevRpm} → </span>
                                  <strong className="text-white">{mod.newRpm}</strong>
                                  <span className="ml-1 text-sky-400 font-bold">
                                    ({mod.deltaRpm > 0 ? `+${mod.deltaRpm}` : mod.deltaRpm})
                                  </span>
                                </div>
                              ) : (
                                <span className="text-slate-500">{mod.newRpm} RPM</span>
                              )}
                            </td>

                            <td className="py-3 px-3 text-right whitespace-nowrap">
                              {mod.deltaAeration !== 0 ? (
                                <div>
                                  <span className="text-slate-400">{mod.prevAeration} → </span>
                                  <strong className="text-white">{mod.newAeration}</strong>
                                  <span className="ml-1 text-sky-400 font-bold">
                                    (
                                    {mod.deltaAeration > 0
                                      ? `+${mod.deltaAeration}`
                                      : mod.deltaAeration}
                                    )
                                  </span>
                                </div>
                              ) : (
                                <span className="text-slate-500">{mod.newAeration} L/min</span>
                              )}
                            </td>

                            <td className="py-3 px-3 text-right whitespace-nowrap">
                              {mod.deltaPressure !== 0 ? (
                                <div>
                                  <span className="text-slate-400">
                                    {formatPressure(mod.prevPressure)} →{' '}
                                  </span>
                                  <strong className="text-white">
                                    {formatPressure(mod.newPressure)}
                                  </strong>
                                  <span className="ml-1 text-sky-400 font-bold">
                                    (
                                    {mod.deltaPressure > 0
                                      ? `+${formatPressure(mod.deltaPressure)}`
                                      : formatPressure(mod.deltaPressure)}
                                    )
                                  </span>
                                </div>
                              ) : (
                                <span className="text-slate-500">
                                  {formatPressure(mod.newPressure)} bar
                                </span>
                              )}
                            </td>

                            <td className="py-3 px-4 font-sans text-slate-300">
                              <div>{mod.summary}</div>
                              {mod.operatorNote && (
                                <div className="text-[11px] text-amber-300 mt-0.5">
                                  Nota: {mod.operatorNote}
                                </div>
                              )}
                            </td>

                            <td className="py-3 px-3 text-right no-print">
                              <button
                                type="button"
                                onClick={() => deleteModificationRecord(mod.id)}
                                title="Remover registro"
                                className="p-1.5 text-slate-500 hover:text-rose-400 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>

            {/* SEÇÃO 3: REPORTE PERIÓDICO A CADA 2 HORAS (0h A 24h) */}
            <section
              id="registro-2h"
              className="bg-[#0F1624] border border-slate-800/90 rounded-xl overflow-hidden"
            >
              <div className="bg-[#131C2E] border-b border-slate-800 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center">
                    03
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-white">
                      REPORTE DE PARÂMETROS A CADA 2 HORAS (0h ATÉ 24h)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Acompanhamento periódico realizado pelos operadores ao longo do cultivo
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 no-print">
                  <button
                    type="button"
                    onClick={recordNextTwoHourSlotNow}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-md transition-colors cursor-pointer"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    Registrar Próximo Horário de 2h
                  </button>

                  <button
                    type="button"
                    onClick={exportTwoHourCsv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Exportar Reporte 2h (CSV)
                  </button>
                </div>
              </div>

              <div className="p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-[#090D16] border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-emerald-400" />
                      Tempo Decorrido de Cultivo
                    </span>
                    <div className="font-mono tabular-nums text-xl font-bold text-white mt-1">
                      T+ {formatCountdownHms(batch.cultivationTracker.elapsedSeconds)}
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:block border-t sm:border-t-0 sm:border-l border-slate-800 pt-2 sm:pt-0 sm:pl-4">
                    <span className="text-xs text-slate-400">Próximo Reporte de 2h em</span>
                    <div className="font-mono tabular-nums text-xl font-bold text-sky-400 mt-1">
                      {formatCountdownHms(secondsUntilNext2hLog)}
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:block border-t sm:border-t-0 sm:border-l border-slate-800 pt-2 sm:pt-0 sm:pl-4">
                    <span className="text-xs text-slate-400">Janelas de 2h Preenchidas</span>
                    <div className="font-mono tabular-nums text-xl font-bold text-emerald-400 mt-1">
                      {recorded2hCount} / {TWO_HOUR_SLOTS.length} horários
                    </div>
                  </div>
                </div>

                {/* Tabela de 2 em 2 Horas */}
                <div className="overflow-x-auto border border-slate-800/90 rounded-xl bg-[#090D16]">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#0B101B] border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400">
                        <th className="py-3 px-4">Janela</th>
                        <th className="py-3 px-3 text-right">O₂ / OD (%)</th>
                        <th className="py-3 px-3 text-right">Agitação (RPM)</th>
                        <th className="py-3 px-3 text-right">Vazão Ar (L/min)</th>
                        <th className="py-3 px-3 text-right">Pressão (bar)</th>
                        <th className="py-3 px-3 text-right">Temp (°C)</th>
                        <th className="py-3 px-4 text-right no-print">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70 text-xs sm:text-sm font-mono tabular-nums">
                      {TWO_HOUR_SLOTS.map((hr) => {
                        const rec = batch.twoHourLogs[hr];
                        const isRecorded = !!rec?.recorded;
                        const isEditing = editingSlotHour === hr;

                        return (
                          <React.Fragment key={hr}>
                            <tr
                              className={`transition-colors ${
                                isRecorded
                                  ? 'bg-emerald-950/15 hover:bg-slate-900'
                                  : 'hover:bg-slate-900/50 text-slate-500'
                              }`}
                            >
                              <td className="py-3 px-4 font-semibold whitespace-nowrap">
                                <div className="flex items-center gap-2">
                                  <span className={isRecorded ? 'text-white' : 'text-slate-400'}>
                                    {hr}h
                                  </span>
                                  {isRecorded && rec?.recordedAt && (
                                    <span className="text-[11px] text-slate-400 font-normal">
                                      ({rec.recordedAt}
                                      {rec.note ? ` · ${rec.note}` : ''})
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td className="py-3 px-3 text-right font-bold">
                                {isRecorded ? (
                                  <span
                                    className={rec.od >= 37 ? 'text-emerald-400' : 'text-amber-400'}
                                  >
                                    {rec.od}%
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>

                              <td className="py-3 px-3 text-right text-slate-200">
                                {isRecorded ? `${rec.rpm} RPM` : '—'}
                              </td>

                              <td className="py-3 px-3 text-right text-slate-200">
                                {isRecorded ? `${rec.aeration} L/min` : '—'}
                              </td>

                              <td className="py-3 px-3 text-right text-slate-200">
                                {isRecorded ? `${formatPressure(rec.pressure)} bar` : '—'}
                              </td>

                              <td className="py-3 px-3 text-right text-sky-300">
                                {isRecorded ? `${rec.temp.toFixed(1).replace('.', ',')} °C` : '—'}
                              </td>

                              <td className="py-3 px-4 text-right whitespace-nowrap no-print">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => recordSpecificTwoHourSlot(hr)}
                                    className="px-2.5 py-1 text-xs font-sans font-medium bg-slate-800 hover:bg-sky-400 hover:text-slate-950 text-sky-300 rounded transition-colors cursor-pointer"
                                  >
                                    {isRecorded ? 'Atualizar' : 'Capturar'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingSlotHour(isEditing ? null : hr)}
                                    className="px-2.5 py-1 text-xs font-sans font-medium bg-slate-900 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition-colors cursor-pointer"
                                  >
                                    {isEditing ? 'Fechar' : 'Editar'}
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {isEditing && (
                              <tr className="bg-slate-900/95 border-b border-slate-800 no-print">
                                <td colSpan={7} className="p-4 space-y-3 font-sans">
                                  <div className="flex items-center justify-between text-xs font-semibold text-sky-300">
                                    <span>Edição Manual — Janela de {hr}h de Cultivo</span>
                                    {isRecorded && (
                                      <button
                                        type="button"
                                        onClick={() => clearTwoHourSlot(hr)}
                                        className="text-rose-400 hover:underline text-xs cursor-pointer"
                                      >
                                        Limpar janela de {hr}h
                                      </button>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                                    <div>
                                      <label className="block text-xs text-slate-400 mb-1">
                                        O₂ / OD (%)
                                      </label>
                                      <input
                                        type="number"
                                        step={0.5}
                                        value={rec?.od ?? 37.0}
                                        onChange={(e) =>
                                          updateTwoHourSlotField(
                                            hr,
                                            'od',
                                            parseFloat(e.target.value) || 0
                                          )
                                        }
                                        className="w-full px-2.5 py-1.5 text-sm font-mono bg-[#090D16] border border-slate-700 rounded text-white"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs text-slate-400 mb-1">
                                        RPM (95 → 230)
                                      </label>
                                      <input
                                        type="number"
                                        step={5}
                                        value={rec?.rpm ?? 95}
                                        onChange={(e) =>
                                          updateTwoHourSlotField(
                                            hr,
                                            'rpm',
                                            parseFloat(e.target.value) || 0
                                          )
                                        }
                                        className="w-full px-2.5 py-1.5 text-sm font-mono bg-[#090D16] border border-slate-700 rounded text-white"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs text-slate-400 mb-1">
                                        Vazão Ar (50 → 200)
                                      </label>
                                      <input
                                        type="number"
                                        step={5}
                                        value={rec?.aeration ?? 50}
                                        onChange={(e) =>
                                          updateTwoHourSlotField(
                                            hr,
                                            'aeration',
                                            parseFloat(e.target.value) || 0
                                          )
                                        }
                                        className="w-full px-2.5 py-1.5 text-sm font-mono bg-[#090D16] border border-slate-700 rounded text-white"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs text-slate-400 mb-1">
                                        Pressão (0,6 → 0,850)
                                      </label>
                                      <input
                                        type="number"
                                        step={0.025}
                                        value={rec?.pressure ?? 0.6}
                                        onChange={(e) =>
                                          updateTwoHourSlotField(
                                            hr,
                                            'pressure',
                                            parseFloat(e.target.value) || 0
                                          )
                                        }
                                        className="w-full px-2.5 py-1.5 text-sm font-mono bg-[#090D16] border border-slate-700 rounded text-white"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs text-slate-400 mb-1">
                                        Temp (28 → 29 °C)
                                      </label>
                                      <input
                                        type="number"
                                        step={0.5}
                                        value={rec?.temp ?? 28}
                                        onChange={(e) =>
                                          updateTwoHourSlotField(
                                            hr,
                                            'temp',
                                            parseFloat(e.target.value) || 0
                                          )
                                        }
                                        className="w-full px-2.5 py-1.5 text-sm font-mono bg-[#090D16] border border-slate-700 rounded text-white"
                                      />
                                    </div>
                                  </div>
                                  <div>
                                    <input
                                      type="text"
                                      maxLength={250}
                                      placeholder="Observação deste horário..."
                                      value={rec?.note ?? ''}
                                      onChange={(e) =>
                                        updateTwoHourSlotField(hr, 'note', e.target.value)
                                      }
                                      className="w-full px-3 py-1.5 text-xs bg-[#090D16] border border-slate-700 rounded text-white placeholder:text-slate-500"
                                    />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Observações Gerais da Batelada */}
                <div className="pt-2">
                  <label
                    htmlFor="general-notes-textarea"
                    className="block text-xs font-medium text-slate-400 mb-1.5"
                  >
                    Observações Gerais do Cultivo / Passagem de Turno:
                  </label>
                  <textarea
                    id="general-notes-textarea"
                    rows={2}
                    maxLength={3000}
                    value={batch.generalNotes}
                    onChange={(e) =>
                      commitUserBatchUpdate((prev) => ({ ...prev, generalNotes: e.target.value }))
                    }
                    placeholder="Registre ocorrências relevantes ou recomendações para o próximo turno..."
                    className="w-full text-sm text-white placeholder:text-slate-600 bg-[#090D16] border border-slate-800 rounded-lg p-3 focus:outline-none focus:border-sky-400 resize-y"
                  />
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      {/* Modal de Confirmação para Nova Batelada */}
      {showResetConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-modal-title"
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 no-print"
        >
          <div className="bg-[#0F1624] border border-slate-700 rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 id="reset-modal-title" className="text-base font-bold text-white">
                  Iniciar Nova Batelada?
                </h3>
                <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed">
                  Isso limpará o histórico de modificações com base no O₂, a tabela de reporte de 2
                  em 2 horas e restaurará os parâmetros iniciais (95 RPM, 50 L/min, 0,600 bar e 28
                  °C) para todos os dispositivos conectados.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleResetBatch}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors cursor-pointer"
              >
                Confirmar e Limpar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
