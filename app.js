import { REXFORCE, RexForceStreamParser, calibrationCommand, buildMockFrame } from "./protocol.js";
import { calculateMetrics } from "./metrics.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  connect: $("#connectBtn"), demo: $("#demoBtn"), status: $("#connectionStatus"), statusDot: $("#statusDot"),
  singleMode: $("#singleModeBtn"), dualMode: $("#dualModeBtn"), modeHelp: $("#modeHelp"),
  deviceName: $("#deviceName"), forceLabel: $("#forceLabel"), value: $("#forceValue"), unit: $("#forceUnit"), peak: $("#peakValue"),
  mean: $("#meanValue"), impulse: $("#impulseValue"), rfd: $("#rfdValue"), elapsed: $("#elapsedValue"),
  start: $("#startBtn"), tare: $("#tareBtn"), export: $("#exportBtn"), canvas: $("#forceChart"),
  sessions: $("#sessionList"), emptySessions: $("#emptySessions"), mode: $("#modeBadge"), samples: $("#sampleBadge"),
  validRate: $("#validRate"), invert: $("#invertToggle"), filter: $("#filterSelect"), unitSelect: $("#unitSelect"),
  dualPanel: $("#dualPanel"), leftValue: $("#leftForceValue"), rightValue: $("#rightForceValue"),
  leftShare: $("#leftShare"), rightShare: $("#rightShare"), asymmetry: $("#asymmetryValue"),
  leftBalance: $("#leftBalanceBar"), rightBalance: $("#rightBalanceBar"),
  leftPeak: $("#leftPeakValue"), rightPeak: $("#rightPeakValue"), sideImpulse: $("#sideImpulseValue"),
  swapSides: $("#swapSidesToggle"), dualLegend: $("#dualChartLegend"),
  dualSettings: $("#dualSettingsRow"),
  settings: $("#settingsDialog"), settingsBtn: $("#settingsBtn"), closeSettings: $("#closeSettings"),
  calMeasured: $("#calMeasured"), calReference: $("#calReference"), calibrate: $("#calibrateBtn"),
  resetFactor: $("#resetFactorBtn"), temperature: $("#temperatureBtn"), disconnect: $("#disconnectBtn"),
  toast: $("#toast"), installHint: $("#installHint"), demoPill: $("#demoPill"),
};

const state = {
  device: null, server: null, tx: null, rx: null, connected: false, demo: false,
  parser: new RexForceStreamParser(), samples: [], displaySamples: [], recording: false,
  sessionSamples: [], sessionStart: 0, offset: 0, latestRaw: 0, latest: 0,
  leftOffset: 0, rightOffset: 0, latestRawLeft: 0, latestRawRight: 0,
  latestLeft: 0, latestRight: 0, filtered: 0, filteredLeft: 0, filteredRight: 0,
  lastFilterTs: null, raf: null, demoTimer: null, demoTs: 0,
  currentMode: "single", selectedMode: localStorage.getItem("rexforce.mode.v1") === "dual" ? "dual" : "single",
  temperatureRaw: null, hasReceivedData: false, lastUiTs: 0,
};

function showToast(message, tone = "normal") {
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function setStatus(kind, label) {
  els.status.textContent = label;
  els.statusDot.dataset.state = kind;
}

function selectedCutoff() {
  const value = Number(els.filter.value);
  return Number.isFinite(value) ? value : 0;
}

function processSample(sample) {
  const direction = els.invert.checked ? -1 : 1;
  const primary = sample.primaryKg * direction;
  const secondary = sample.secondaryKg * direction;
  const dual = state.selectedMode === "dual";
  const rawLeft = dual ? (els.swapSides.checked ? secondary : primary) : primary;
  const rawRight = dual ? (els.swapSides.checked ? primary : secondary) : 0;
  const raw = rawLeft + rawRight;
  state.latestRaw = raw;
  state.latestRawLeft = rawLeft;
  state.latestRawRight = rawRight;
  const adjusted = raw - state.offset;
  const adjustedLeft = rawLeft - state.leftOffset;
  const adjustedRight = rawRight - state.rightOffset;
  const cutoff = selectedCutoff();
  if (!cutoff || state.lastFilterTs === null) {
    state.filtered = adjusted;
    state.filteredLeft = adjustedLeft;
    state.filteredRight = adjustedRight;
  } else {
    const dt = Math.max(0.0005, (sample.timestampMs - state.lastFilterTs) / 1000);
    const rc = 1 / (2 * Math.PI * cutoff);
    const alpha = dt / (rc + dt);
    state.filtered += alpha * (adjusted - state.filtered);
    state.filteredLeft += alpha * (adjustedLeft - state.filteredLeft);
    state.filteredRight += alpha * (adjustedRight - state.filteredRight);
  }
  state.lastFilterTs = sample.timestampMs;
  state.latest = state.filtered;
  state.latestLeft = state.filteredLeft;
  state.latestRight = state.filteredRight;
  const processed = { ...sample, valueKg: state.filtered, rawKg: raw, leftKg: state.filteredLeft, rightKg: state.filteredRight };
  state.samples.push(processed);
  if (state.samples.length > 12000) state.samples.splice(0, state.samples.length - 12000);
  if (state.recording) state.sessionSamples.push(processed);
}

function consumeEvents(events) {
  for (const event of events) {
    if (event.type === "temperature") {
      state.temperatureRaw = event.raw;
      showToast(`温度原始值：${event.raw}`);
      continue;
    }
    state.currentMode = event.mode;
    event.samples.forEach(processSample);
    if (!state.hasReceivedData && event.samples.length) {
      state.hasReceivedData = true;
      if (state.connected) setStatus("connected", `数据接收中 · ${event.mode === "dual" ? "双机" : "单机"}`);
    }
  }
}

function resetStreamState() {
  state.parser.reset();
  state.samples = [];
  state.sessionSamples = [];
  state.recording = false;
  state.offset = 0;
  state.leftOffset = 0;
  state.rightOffset = 0;
  state.latestRaw = 0;
  state.latestRawLeft = 0;
  state.latestRawRight = 0;
  state.latest = 0;
  state.latestLeft = 0;
  state.latestRight = 0;
  state.filtered = 0;
  state.filteredLeft = 0;
  state.filteredRight = 0;
  state.lastFilterTs = null;
  state.currentMode = "single";
  state.hasReceivedData = false;
  els.start.textContent = "开始测试";
  els.start.classList.remove("recording");
}

function setTestMode(mode, announce = true) {
  if (mode !== "single" && mode !== "dual") return;
  if (state.recording) {
    showToast("请先结束当前测试再切换模式", "error");
    return;
  }
  const changed = state.selectedMode !== mode;
  state.selectedMode = mode;
  localStorage.setItem("rexforce.mode.v1", mode);
  els.singleMode.classList.toggle("is-active", mode === "single");
  els.dualMode.classList.toggle("is-active", mode === "dual");
  els.singleMode.setAttribute("aria-pressed", String(mode === "single"));
  els.dualMode.setAttribute("aria-pressed", String(mode === "dual"));
  if (changed) {
    state.samples = [];
    state.sessionSamples = [];
    state.offset = 0;
    state.leftOffset = 0;
    state.rightOffset = 0;
    state.filtered = 0;
    state.filteredLeft = 0;
    state.filteredRight = 0;
    state.lastFilterTs = null;
  }
  if (announce) showToast(mode === "dual" ? "已切换到双机模式" : "已切换到单机模式");
}

function notificationHandler(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  consumeEvents(state.parser.push(bytes));
}

async function connectDevice() {
  if (!navigator.bluetooth) {
    showToast("当前浏览器不支持网页蓝牙；iPhone 请使用 Bluefy", "error");
    els.installHint.hidden = false;
    return;
  }
  try {
    setStatus("busy", "请在列表选择 Force-XXXX");
    const device = await navigator.bluetooth.requestDevice({
      // Bluefy on iOS can miss devices when requestDevice uses a namePrefix
      // filter, even though the same peripheral is visible to native apps.
      // Show every nearby BLE peripheral and let the user choose Force-XXXX.
      acceptAllDevices: true,
      optionalServices: [REXFORCE.SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);
    state.device = device;
    setStatus("busy", "正在连接");
    state.server = await device.gatt.connect();
    const service = await state.server.getPrimaryService(REXFORCE.SERVICE_UUID);
    state.tx = await service.getCharacteristic(REXFORCE.TX_UUID);
    state.rx = await service.getCharacteristic(REXFORCE.RX_UUID);
    resetStreamState();
    await state.tx.startNotifications();
    state.tx.addEventListener("characteristicvaluechanged", notificationHandler);
    state.connected = true;
    state.demo = false;
    els.deviceName.textContent = device.name || "RexForce";
    els.connect.textContent = "已连接";
    els.demoPill.hidden = true;
    setStatus("connected", "已连接，等待数据");
    showToast(`已连接 ${device.name || "RexForce"}`);
  } catch (error) {
    if (error.name === "NotFoundError") setStatus("idle", "未选择设备");
    else {
      setStatus("error", "连接失败");
      const message = error.name === "NotSupportedError"
        ? "所选设备没有 RexForce 服务，请选择 Force-XXXX"
        : (error.message || "连接失败");
      showToast(message, "error");
    }
  }
}

function onDisconnected() {
  const wasRecording = state.recording;
  if (wasRecording) finishRecording();
  state.connected = false;
  state.tx = null;
  state.rx = null;
  els.connect.textContent = "连接设备";
  setStatus("idle", "设备已断开");
  showToast(wasRecording ? "设备断开，测试已自动保存" : "蓝牙连接已断开", "error");
}

async function disconnectDevice(sendCommand = true) {
  stopDemo();
  try {
    if (sendCommand && state.rx) await state.rx.writeValueWithoutResponse(new Uint8Array([0x54, 0xde]));
  } catch (_) {}
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  state.connected = false;
  setStatus("idle", "等待连接");
  els.deviceName.textContent = "未连接设备";
  els.connect.textContent = "连接设备";
}

function startDemo() {
  if (state.recording) finishRecording();
  if (state.connected) disconnectDevice(false);
  stopDemo();
  resetStreamState();
  state.demo = true;
  state.demoTs = 0;
  state.parser.reset();
  els.deviceName.textContent = "模拟训练数据";
  els.demoPill.hidden = false;
  setStatus("demo", "演示模式");
  let phase = 0;
  state.demoTimer = setInterval(() => {
    const dual = state.selectedMode === "dual";
    const values = Array.from({ length: dual ? 40 : 80 }, (_, index) => {
      const t = (phase + index * (dual ? 2 : 1)) / 1000;
      const rep = t % 4.5;
      const effort = rep > 0.7 && rep < 3.2 ? Math.sin(((rep - 0.7) / 2.5) * Math.PI) ** 0.65 : 0;
      const left = Math.max(0, effort * 49 + Math.sin(t * 27) * 0.5 + (Math.random() - 0.5) * 0.5);
      const right = Math.max(0, effort * 43 + Math.sin(t * 29 + .7) * 0.5 + (Math.random() - 0.5) * 0.5);
      return dual ? [left, right] : left + right;
    });
    consumeEvents(state.parser.push(buildMockFrame({ timestamp: state.demoTs % 65535, mode: state.selectedMode, values })));
    state.demoTs += 80;
    phase += 80;
  }, 80);
  showToast("演示数据已启动");
}

function stopDemo() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
  state.demo = false;
}

function toggleRecording() {
  if (!state.connected && !state.demo) {
    showToast("请先连接设备或启动演示", "error");
    return;
  }
  if (!state.recording) {
    state.recording = true;
    state.sessionSamples = [];
    state.sessionStart = Date.now();
    els.start.textContent = "结束测试";
    els.start.classList.add("recording");
    showToast("测试已开始");
  } else {
    finishRecording();
  }
}

function finishRecording() {
  state.recording = false;
  els.start.textContent = "开始测试";
  els.start.classList.remove("recording");
  if (state.sessionSamples.length < 2) return;
  const summary = calculateMetrics(state.sessionSamples);
  const session = {
    id: Date.now(), createdAt: new Date().toISOString(), mode: state.selectedMode,
    duration: summary.duration, peak: summary.peak, mean: summary.mean,
    impulse: summary.impulse, rfd: summary.rfd,
    leftPeak: summary.leftPeak, rightPeak: summary.rightPeak,
    leftImpulse: summary.leftImpulse, rightImpulse: summary.rightImpulse,
    curve: downsample(state.sessionSamples, 500).map((p) => [p.timestampMs, p.valueKg]),
  };
  const sessions = loadSessions();
  sessions.unshift(session);
  localStorage.setItem("rexforce.sessions.v1", JSON.stringify(sessions.slice(0, 30)));
  renderSessions();
  showToast("测试已保存到本机");
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const result = [];
  const bucket = points.length / maxPoints;
  for (let i = 0; i < maxPoints; i += 1) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let best = points[start];
    for (let j = start + 1; j < end; j += 1) if (Math.abs(points[j].valueKg) > Math.abs(best.valueKg)) best = points[j];
    result.push(best);
  }
  return result;
}

function loadSessions() {
  try { return JSON.parse(localStorage.getItem("rexforce.sessions.v1")) || []; }
  catch (_) { return []; }
}

function renderSessions() {
  const sessions = loadSessions();
  els.emptySessions.hidden = sessions.length > 0;
  els.sessions.innerHTML = "";
  sessions.slice(0, 5).forEach((session) => {
    const item = document.createElement("button");
    item.className = "session-row";
    const date = new Date(session.createdAt);
    const sideSummary = session.mode === "dual" && Number.isFinite(session.leftPeak) ? `左 ${session.leftPeak.toFixed(1)} · 右 ${session.rightPeak.toFixed(1)} kg` : "峰值";
    item.innerHTML = `<span><strong>${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</strong><small>${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · ${session.duration.toFixed(1)} 秒</small></span><span><strong>${session.peak.toFixed(1)} kg</strong><small>${sideSummary}</small></span>`;
    item.addEventListener("click", () => showToast(`峰值 ${session.peak.toFixed(1)} kg · 冲量 ${session.impulse.toFixed(0)} N·s`));
    els.sessions.appendChild(item);
  });
}

function exportCsv() {
  const points = state.recording ? state.sessionSamples : state.samples;
  if (!points.length) return showToast("暂无可导出的数据", "error");
  const rows = ["timestamp_ms,primary_kg,secondary_kg,left_kg,right_kg,total_raw_kg,total_filtered_kg"];
  for (const p of points) rows.push([p.timestampMs, p.primaryKg, p.secondaryKg, p.leftKg ?? p.valueKg, p.rightKg ?? 0, p.rawKg, p.valueKg].join(","));
  const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rexforce-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("CSV 已生成");
}

async function sendCommand(bytes, successMessage) {
  if (!state.rx) return showToast("请先连接 RexForce", "error");
  try {
    if (state.rx.properties.writeWithoutResponse) await state.rx.writeValueWithoutResponse(bytes);
    else await state.rx.writeValue(bytes);
    if (successMessage) showToast(successMessage);
  } catch (error) { showToast(error.message || "指令发送失败", "error"); }
}

function tare() {
  if (!state.hasReceivedData && !state.demo) return showToast("尚未收到测力数据", "error");
  state.offset = state.latestRaw;
  state.leftOffset = state.latestRawLeft;
  state.rightOffset = state.latestRawRight;
  state.filtered = 0;
  state.filteredLeft = 0;
  state.filteredRight = 0;
  showToast("已在软件中归零");
}

function displayValue(kg) {
  return els.unitSelect.value === "n" ? kg * 9.80665 : kg;
}

function displayUnit() { return els.unitSelect.value === "n" ? "N" : "kg"; }

function updateDashboard(now = 0) {
  if (now - state.lastUiTs < 66) {
    state.raf = requestAnimationFrame(updateDashboard);
    return;
  }
  state.lastUiTs = now;
  const unit = displayUnit();
  els.value.textContent = displayValue(state.latest).toFixed(1);
  els.unit.textContent = unit;
  const active = state.recording ? state.sessionSamples : state.samples.slice(-5000);
  const metrics = calculateMetrics(active);
  els.peak.textContent = `${displayValue(metrics.peak).toFixed(1)} ${unit}`;
  els.mean.textContent = `${displayValue(metrics.mean).toFixed(1)} ${unit}`;
  els.impulse.textContent = `${metrics.impulse.toFixed(0)} N·s`;
  els.rfd.textContent = `${metrics.rfd.toFixed(0)} N/s`;
  const dual = state.selectedMode === "dual";
  const hardwareDual = state.currentMode === "dual";
  els.forceLabel.textContent = dual ? "实时合力" : "实时力";
  els.dualPanel.hidden = !dual;
  els.dualLegend.hidden = !dual;
  els.dualSettings.hidden = !dual;
  if (dual) {
    const left = Math.max(0, state.latestLeft);
    const right = Math.max(0, state.latestRight);
    const sideTotal = left + right;
    const leftShare = sideTotal > 0.2 ? (left / sideTotal) * 100 : 50;
    const rightShare = 100 - leftShare;
    const asymmetry = sideTotal > 0.2 ? (Math.abs(left - right) / sideTotal) * 100 : 0;
    els.leftValue.textContent = `${displayValue(state.latestLeft).toFixed(1)} ${unit}`;
    els.rightValue.textContent = `${displayValue(state.latestRight).toFixed(1)} ${unit}`;
    els.leftShare.textContent = `${leftShare.toFixed(1)}%`;
    els.rightShare.textContent = `${rightShare.toFixed(1)}%`;
    els.asymmetry.textContent = `${asymmetry.toFixed(1)}%`;
    els.leftBalance.style.width = `${leftShare}%`;
    els.rightBalance.style.width = `${rightShare}%`;
    els.leftPeak.textContent = `${displayValue(metrics.leftPeak).toFixed(1)} ${unit}`;
    els.rightPeak.textContent = `${displayValue(metrics.rightPeak).toFixed(1)} ${unit}`;
    els.sideImpulse.textContent = `${metrics.leftImpulse.toFixed(0)} / ${metrics.rightImpulse.toFixed(0)} N·s`;
  }
  els.elapsed.textContent = `${(state.recording ? (Date.now() - state.sessionStart) / 1000 : metrics.duration).toFixed(1)} s`;
  els.mode.textContent = dual ? (hardwareDual ? "双机 · 已就绪" : "双机 · 等待副机") : "单机";
  els.modeHelp.textContent = dual
    ? (hardwareDual ? "双机模式：主副平台已识别，可测量左右脚力量。" : "双机模式：请用 Type-C 连接副设备，并保持主设备为 BLE 模式。")
    : (hardwareDual ? "单机模式：当前仅显示主设备；已检测到副设备数据。" : "单机模式：记录一块测力台的实时力量与训练指标。");
  els.samples.textContent = `${state.parser.stats.validPoints.toLocaleString()} 点`;
  const total = state.parser.stats.validPoints + state.parser.stats.invalidPoints;
  els.validRate.textContent = total ? `${((state.parser.stats.validPoints / total) * 100).toFixed(1)}%` : "—";
  drawChart();
  state.raf = requestAnimationFrame(updateDashboard);
}

function drawChart() {
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const points = state.samples.slice(-6000);
  const pad = 16 * dpr;
  ctx.strokeStyle = "rgba(148,163,184,.13)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
  }
  if (points.length < 2) return;
  const dual = state.currentMode === "dual";
  const plottedValues = dual ? points.flatMap((p) => [p.valueKg, p.leftKg ?? 0, p.rightKg ?? 0]) : points.map((p) => p.valueKg);
  const maxAbs = Math.max(10, ...plottedValues.map(Math.abs)) * 1.12;
  const startTs = points[0].timestampMs;
  const endTs = Math.max(startTs + 1, points.at(-1).timestampMs);
  const reduced = downsample(points, Math.min(900, Math.floor(rect.width * 1.5)));
  const plot = (key, color, lineWidth) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    reduced.forEach((p, i) => {
      const x = pad + ((p.timestampMs - startTs) / (endTs - startTs)) * (width - pad * 2);
      const y = height - pad - (((p[key] ?? 0) + maxAbs * 0.08) / (maxAbs * 1.08)) * (height - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  if (dual) {
    plot("leftKg", "#e63946", 1.45);
    plot("rightKg", "#2f6df6", 1.45);
  }
  plot("valueKg", "#f8fbff", 2.25);
}

els.connect.addEventListener("click", () => state.connected ? disconnectDevice() : connectDevice());
els.singleMode.addEventListener("click", () => setTestMode("single"));
els.dualMode.addEventListener("click", () => setTestMode("dual"));
els.demo.addEventListener("click", () => state.demo ? (stopDemo(), setStatus("idle", "等待连接"), els.demoPill.hidden = true) : startDemo());
els.start.addEventListener("click", toggleRecording);
els.tare.addEventListener("click", tare);
els.export.addEventListener("click", exportCsv);
els.settingsBtn.addEventListener("click", () => els.settings.showModal());
els.closeSettings.addEventListener("click", () => els.settings.close());
els.disconnect.addEventListener("click", () => { disconnectDevice(); els.settings.close(); });
els.resetFactor.addEventListener("click", () => sendCommand(new Uint8Array([0x54, 0xf8]), "已恢复默认比例系数"));
els.temperature.addEventListener("click", () => sendCommand(new Uint8Array([0x54, 0xdd]), "已请求温度原始值"));
els.calibrate.addEventListener("click", () => {
  try { sendCommand(calibrationCommand(Number(els.calMeasured.value), Number(els.calReference.value)), "校准因子已发送并保存"); }
  catch (error) { showToast(error.message, "error"); }
});
els.invert.addEventListener("change", () => { state.offset = 0; state.lastFilterTs = null; });
els.swapSides.addEventListener("change", () => { state.leftOffset = 0; state.rightOffset = 0; state.lastFilterTs = null; });
els.filter.addEventListener("change", () => { state.lastFilterTs = null; });

window.addEventListener("beforeunload", () => stopDemo());
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
renderSessions();
setTestMode(state.selectedMode, false);
updateDashboard();
