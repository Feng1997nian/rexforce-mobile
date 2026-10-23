import { REXFORCE, RexForceStreamParser, calibrationCommand, buildMockFrame } from "./protocol.js";
import { calculateMetrics } from "./metrics.js";
import { analyzeJumps } from "./jump-metrics.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  connect: $("#connectBtn"), demo: $("#demoBtn"), status: $("#connectionStatus"), statusDot: $("#statusDot"),
  singleMode: $("#singleModeBtn"), dualMode: $("#dualModeBtn"), modeHelp: $("#modeHelp"),
  strengthTest: $("#strengthTestBtn"), cmjTest: $("#cmjTestBtn"), repeatJumpTest: $("#repeatJumpTestBtn"), testHelp: $("#testHelp"),
  deviceName: $("#deviceName"), forceLabel: $("#forceLabel"), value: $("#forceValue"), unit: $("#forceUnit"), peak: $("#peakValue"),
  mean: $("#meanValue"), impulse: $("#impulseValue"), rfd: $("#rfdValue"), elapsed: $("#elapsedValue"),
  peakLabel: $("#peakLabel"), meanLabel: $("#meanLabel"), impulseLabel: $("#impulseLabel"), rfdLabel: $("#rfdLabel"),
  jumpPanel: $("#jumpPanel"), jumpPanelTitle: $("#jumpPanelTitle"), jumpStatus: $("#jumpStatus"), jumpList: $("#jumpList"),
  start: $("#startBtn"), tare: $("#tareBtn"), export: $("#exportBtn"), canvas: $("#forceChart"),
  exportDialog: $("#exportDialog"), closeExport: $("#closeExport"), exportHint: $("#exportHint"),
  exportOptions: $("#exportOptions"), exportImage: $("#exportImageBtn"), exportCsv: $("#exportCsvBtn"),
  exportPreviewPanel: $("#exportPreviewPanel"), exportPreview: $("#exportPreview"),
  exportShare: $("#exportShareBtn"), exportDownload: $("#exportDownloadBtn"), exportBack: $("#exportBackBtn"),
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
  device: null, server: null, tx: null, rx: null, connected: false, connecting: false, disconnecting: false, demo: false,
  parser: new RexForceStreamParser(), samples: [], displaySamples: [], recording: false,
  sessionSamples: [], sessionStart: 0, offset: 0, latestRaw: 0, latest: 0,
  leftOffset: 0, rightOffset: 0, latestRawLeft: 0, latestRawRight: 0,
  latestLeft: 0, latestRight: 0, filtered: 0, filteredLeft: 0, filteredRight: 0,
  lastFilterTs: null, raf: null, demoTimer: null, demoTs: 0, demoPhase: 0,
  currentMode: "single", selectedMode: localStorage.getItem("rexforce.mode.v1") === "dual" ? "dual" : "single",
  assessment: ["strength", "cmj", "repeat"].includes(localStorage.getItem("rexforce.assessment.v1")) ? localStorage.getItem("rexforce.assessment.v1") : "strength",
  temperatureRaw: null, hasReceivedData: false, lastUiTs: 0,
  lastCompletedSamples: [], lastCompletedAt: null, lastCompletedMode: "single", lastCompletedAssessment: "strength",
  jumpAnalysis: { bodyMassKg: 0, jumps: [], cmj: null }, lastJumpAnalysisAt: 0, renderedJumpCount: -1,
  exportBlob: null, exportFilename: "", exportPreviewUrl: "",
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

function setAssessment(type, announce = true) {
  if (!["strength", "cmj", "repeat"].includes(type)) return;
  if (state.recording) {
    showToast("请先结束当前测试再切换类型", "error");
    return;
  }
  state.assessment = type;
  localStorage.setItem("rexforce.assessment.v1", type);
  [[els.strengthTest, "strength"], [els.cmjTest, "cmj"], [els.repeatJumpTest, "repeat"]].forEach(([button, value]) => {
    const active = value === type;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.jumpPanel.hidden = type === "strength";
  if (type === "strength") {
    els.testHelp.textContent = "记录实时力量、峰值、平均力、冲量与最大 RFD。";
    [els.peakLabel.textContent, els.meanLabel.textContent, els.impulseLabel.textContent, els.rfdLabel.textContent] = ["峰值力", "平均力", "冲量", "最大 RFD"];
    els.start.textContent = "开始测试";
  } else if (type === "cmj") {
    els.testHelp.textContent = "开始后安静站立约 1 秒，再完成一次最大努力反向纵跳。";
    [els.peakLabel.textContent, els.meanLabel.textContent, els.impulseLabel.textContent, els.rfdLabel.textContent] = ["跳跃高度", "滞空时间", "起跳用时", "RSImod"];
    els.jumpPanelTitle.textContent = "CMJ 阶段识别";
    els.start.textContent = "开始 CMJ";
  } else {
    els.testHelp.textContent = "开始后安静站立约 1 秒，再连续起跳；尽量跳高并缩短触地时间。";
    [els.peakLabel.textContent, els.meanLabel.textContent, els.impulseLabel.textContent, els.rfdLabel.textContent] = ["有效跳数", "最佳高度", "平均高度", "最佳 RSI"];
    els.jumpPanelTitle.textContent = "连续跳明细";
    els.start.textContent = "开始连续跳";
  }
  renderJumpResults({ jumps: [], cmj: null });
  if (announce) showToast(type === "cmj" ? "已切换到 CMJ" : type === "repeat" ? "已切换到连续跳" : "已切换到力量测试");
}

function renderJumpResults(analysis) {
  if (state.assessment === "strength") return;
  const jumps = analysis.jumps || [];
  els.jumpStatus.textContent = jumps.length ? `${jumps.length} 跳已识别` : "等待起跳";
  if (!jumps.length) {
    els.jumpList.innerHTML = '<p class="empty">开始测试后，先安静站立约 1 秒再起跳。</p>';
    return;
  }
  const shown = state.assessment === "cmj" ? jumps.slice(0, 1) : jumps;
  els.jumpList.innerHTML = shown.map((jump) => {
    const contact = jump.contactTime ? `${Math.round(jump.contactTime * 1000)} ms` : "—";
    const index = state.assessment === "cmj" ? "CMJ" : `#${jump.number}`;
    return `<div class="jump-row"><strong>${index}</strong><span><small>高度</small><b>${(jump.jumpHeightM * 100).toFixed(1)} cm</b></span><span><small>滞空</small><b>${Math.round(jump.flightTime * 1000)} ms</b></span><span><small>${state.assessment === "cmj" ? "RSImod" : "触地 / RSI"}</small><b>${state.assessment === "cmj" ? (analysis.cmj?.rsiMod?.toFixed(2) ?? "—") : `${contact} / ${jump.rsi?.toFixed(2) ?? "—"}`}</b></span></div>`;
  }).join("");
}

function notificationHandler(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  consumeEvents(state.parser.push(bytes));
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isTransientGattError(error) {
  return error?.name === "NetworkError"
    || error?.name === "InvalidStateError"
    || /gatt|disconnect|connection/i.test(error?.message || "");
}

async function discoverRexForce(device, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      setStatus("busy", attempt === 1 ? "正在连接" : `连接中断，自动重试 ${attempt}/${attempts}`);
      state.server = device.gatt.connected ? device.gatt : await device.gatt.connect();
      // Some Bluetooth stacks report connected slightly before GATT service
      // discovery is ready. A short settle avoids an immediate disconnect error.
      await wait(250);
      if (!device.gatt.connected) throw new DOMException("GATT disconnected during setup", "NetworkError");
      const service = await state.server.getPrimaryService(REXFORCE.SERVICE_UUID);
      const tx = await service.getCharacteristic(REXFORCE.TX_UUID);
      const rx = await service.getCharacteristic(REXFORCE.RX_UUID);
      await tx.startNotifications();
      if (!device.gatt.connected) throw new DOMException("GATT disconnected during setup", "NetworkError");
      return { tx, rx };
    } catch (error) {
      lastError = error;
      state.server = null;
      state.tx = null;
      state.rx = null;
      if (device.gatt.connected) device.gatt.disconnect();
      if (!isTransientGattError(error) || attempt === attempts) break;
      await wait(450 * attempt);
    }
  }
  throw lastError;
}

async function connectDevice() {
  if (!navigator.bluetooth) {
    showToast("当前浏览器不支持网页蓝牙；iPhone 请使用 Bluefy", "error");
    els.installHint.hidden = false;
    return;
  }
  if (state.connecting) return;
  state.connecting = true;
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
    const characteristics = await discoverRexForce(device);
    state.tx = characteristics.tx;
    state.rx = characteristics.rx;
    resetStreamState();
    state.tx.addEventListener("characteristicvaluechanged", notificationHandler);
    state.connected = true;
    state.connecting = false;
    state.demo = false;
    els.deviceName.textContent = device.name || "RexForce";
    els.connect.textContent = "已连接";
    els.demoPill.hidden = true;
    setStatus("connected", "已连接，等待数据");
    showToast(`已连接 ${device.name || "RexForce"}`);
  } catch (error) {
    state.connecting = false;
    state.connected = false;
    els.connect.textContent = "连接设备";
    if (error.name === "NotFoundError") setStatus("idle", "未选择设备");
    else {
      setStatus("error", "连接失败");
      const message = error.name === "NotSupportedError"
        ? "所选设备没有 RexForce 服务，请选择 Force-XXXX"
        : isTransientGattError(error)
          ? "蓝牙连接被中断。请关闭正在连接测力台的其他软件，确认设备有电后重试"
        : (error.message || "连接失败");
      showToast(message, "error");
    }
  }
}

function onDisconnected() {
  state.server = null;
  state.tx = null;
  state.rx = null;
  if (state.connecting) return;
  if (state.disconnecting) {
    state.disconnecting = false;
    return;
  }
  const wasRecording = state.recording;
  if (wasRecording) finishRecording();
  state.connected = false;
  els.connect.textContent = "连接设备";
  setStatus("idle", "设备已断开");
  showToast(wasRecording ? "设备断开，测试已自动保存" : "蓝牙连接已断开", "error");
}

async function disconnectDevice(sendCommand = true) {
  stopDemo();
  try {
    if (sendCommand && state.rx) await state.rx.writeValueWithoutResponse(new Uint8Array([0x54, 0xde]));
  } catch (_) {}
  if (state.device?.gatt?.connected) {
    state.disconnecting = true;
    state.device.gatt.disconnect();
  }
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
  els.demo.textContent = "停止演示数据";
  els.demoPill.hidden = false;
  setStatus("demo", "演示模式");
  state.demoPhase = 0;
  state.demoTimer = setInterval(() => {
    const dual = state.selectedMode === "dual";
    const values = Array.from({ length: dual ? 40 : 80 }, (_, index) => {
      const t = (state.demoPhase + index * (dual ? 2 : 1)) / 1000;
      let total;
      if (state.assessment === "strength") {
        const rep = t % 4.5;
        const effort = rep > 0.7 && rep < 3.2 ? Math.sin(((rep - 0.7) / 2.5) * Math.PI) ** 0.65 : 0;
        total = Math.max(0, effort * 92 + Math.sin(t * 27) * 0.6);
      } else if (state.assessment === "cmj") {
        if (t < 1.2) total = 75;
        else if (t < 1.5) total = 55;
        else if (t < 1.8) total = 115;
        else if (t < 2.3) total = 0;
        else if (t < 2.55) total = 130;
        else total = 75;
      } else {
        if (t < 1.1) total = 75;
        else {
          const rep = (t - 1.1) % .82;
          total = rep < .22 ? 115 : rep < .62 ? 0 : 125;
        }
      }
      total = Math.max(0, total + (Math.random() - .5) * .35);
      return dual ? [total * .52, total * .48] : total;
    });
    consumeEvents(state.parser.push(buildMockFrame({ timestamp: state.demoTs % 65535, mode: state.selectedMode, values })));
    state.demoTs += 80;
    state.demoPhase += 80;
  }, 80);
  showToast("演示数据已启动");
}

function stopDemo() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
  state.demo = false;
  els.demo.textContent = "启动演示数据";
}

function toggleRecording() {
  if (!state.connected && !state.demo) {
    showToast("请先连接设备或启动演示", "error");
    return;
  }
  if (!state.recording) {
    if (state.demo && state.assessment !== "strength") state.demoPhase = 0;
    state.recording = true;
    state.sessionSamples = [];
    state.jumpAnalysis = { bodyMassKg: 0, jumps: [], cmj: null };
    state.lastJumpAnalysisAt = 0;
    state.renderedJumpCount = -1;
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
  els.start.textContent = state.assessment === "cmj" ? "开始 CMJ" : state.assessment === "repeat" ? "开始连续跳" : "开始测试";
  els.start.classList.remove("recording");
  if (state.sessionSamples.length < 2) return;
  state.lastCompletedSamples = state.sessionSamples.slice();
  state.lastCompletedAt = new Date();
  state.lastCompletedMode = state.selectedMode;
  state.lastCompletedAssessment = state.assessment;
  const summary = calculateMetrics(state.sessionSamples);
  const jumpAnalysis = analyzeJumps(state.sessionSamples);
  const heights = jumpAnalysis.jumps.map((jump) => jump.jumpHeightM);
  const rsiValues = jumpAnalysis.jumps.map((jump) => jump.rsi).filter(Number.isFinite);
  const session = {
    id: Date.now(), createdAt: new Date().toISOString(), mode: state.selectedMode, assessment: state.assessment,
    duration: summary.duration, peak: summary.peak, mean: summary.mean,
    impulse: summary.impulse, rfd: summary.rfd,
    leftPeak: summary.leftPeak, rightPeak: summary.rightPeak,
    leftImpulse: summary.leftImpulse, rightImpulse: summary.rightImpulse,
    jumpCount: jumpAnalysis.jumps.length,
    jumpHeightCm: jumpAnalysis.cmj ? jumpAnalysis.cmj.jumpHeightM * 100 : 0,
    flightTimeMs: jumpAnalysis.cmj ? jumpAnalysis.cmj.flightTime * 1000 : 0,
    timeToTakeoffMs: jumpAnalysis.cmj?.timeToTakeoff ? jumpAnalysis.cmj.timeToTakeoff * 1000 : 0,
    rsiMod: jumpAnalysis.cmj?.rsiMod || 0,
    bestJumpCm: heights.length ? Math.max(...heights) * 100 : 0,
    meanJumpCm: heights.length ? (heights.reduce((sum, value) => sum + value, 0) / heights.length) * 100 : 0,
    bestRsi: rsiValues.length ? Math.max(...rsiValues) : 0,
    curve: downsample(state.sessionSamples, 500).map((p) => [p.timestampMs, p.valueKg]),
  };
  const sessions = loadSessions();
  sessions.unshift(session);
  localStorage.setItem("rexforce.sessions.v1", JSON.stringify(sessions.slice(0, 30)));
  renderSessions();
  if (state.assessment === "cmj" && !jumpAnalysis.cmj) showToast("未识别到完整跳跃，请保持完整离台和落地", "error");
  else if (state.assessment === "repeat" && !jumpAnalysis.jumps.length) showToast("未识别到完整跳跃", "error");
  else showToast("测试已保存，可导出结果");
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
    const type = session.assessment || "strength";
    const sideSummary = session.mode === "dual" && Number.isFinite(session.leftPeak) ? `左 ${session.leftPeak.toFixed(1)} · 右 ${session.rightPeak.toFixed(1)} kg` : "峰值";
    const result = type === "cmj" ? `${(session.jumpHeightCm || 0).toFixed(1)} cm` : type === "repeat" ? `${session.jumpCount || 0} 跳` : `${session.peak.toFixed(1)} kg`;
    const resultLabel = type === "cmj" ? `CMJ · RSImod ${(session.rsiMod || 0).toFixed(2)}` : type === "repeat" ? `最佳 RSI ${(session.bestRsi || 0).toFixed(2)}` : sideSummary;
    item.innerHTML = `<span><strong>${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</strong><small>${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · ${session.duration.toFixed(1)} 秒</small></span><span><strong>${result}</strong><small>${resultLabel}</small></span>`;
    item.addEventListener("click", () => showToast(type === "cmj" ? `跳高 ${(session.jumpHeightCm || 0).toFixed(1)} cm · 滞空 ${Math.round(session.flightTimeMs || 0)} ms` : type === "repeat" ? `${session.jumpCount || 0} 跳 · 最佳 RSI ${(session.bestRsi || 0).toFixed(2)}` : `峰值 ${session.peak.toFixed(1)} kg · 冲量 ${session.impulse.toFixed(0)} N·s`));
    els.sessions.appendChild(item);
  });
}

function exportPoints() {
  if (state.recording && state.sessionSamples.length) return state.sessionSamples;
  if (state.lastCompletedSamples.length) return state.lastCompletedSamples;
  return state.samples;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const points = exportPoints();
  if (!points.length) return showToast("暂无可导出的数据", "error");
  const rows = ["timestamp_ms,primary_kg,secondary_kg,left_kg,right_kg,total_raw_kg,total_filtered_kg"];
  for (const p of points) rows.push([p.timestampMs, p.primaryKg, p.secondaryKg, p.leftKg ?? p.valueKg, p.rightKg ?? 0, p.rawKg, p.valueKg].join(","));
  const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `rexforce-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  els.exportDialog.close();
  showToast("CSV 已生成");
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawReportMetric(ctx, x, y, width, label, value, accent) {
  roundedRect(ctx, x, y, width, 170, 24);
  ctx.fillStyle = "#0c1b3d";
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 8, 170);
  ctx.fillStyle = "#91a8cf";
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText(label, x + 34, y + 54);
  ctx.fillStyle = "#f8fbff";
  ctx.font = "800 46px system-ui, sans-serif";
  ctx.fillText(value, x + 34, y + 122);
}

async function buildResultImage() {
  const points = exportPoints();
  if (points.length < 2) {
    showToast("请先完成一次测试", "error");
    return null;
  }
  const summary = calculateMetrics(points);
  const reportMode = state.recording || !state.lastCompletedSamples.length ? state.selectedMode : state.lastCompletedMode;
  const reportAssessment = state.recording || !state.lastCompletedSamples.length ? state.assessment : state.lastCompletedAssessment;
  const jumpAnalysis = analyzeJumps(points);
  const reportDate = state.lastCompletedAt || new Date();
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = reportMode === "dual" ? 1900 : 1740;
  const ctx = canvas.getContext("2d");
  const background = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  background.addColorStop(0, "#061634");
  background.addColorStop(.58, "#040b1c");
  background.addColorStop(1, "#240917");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const brandGradient = ctx.createLinearGradient(74, 72, 190, 188);
  brandGradient.addColorStop(0, "#2f6df6");
  brandGradient.addColorStop(.48, "#2f6df6");
  brandGradient.addColorStop(.5, "#ffffff");
  brandGradient.addColorStop(.55, "#d7193f");
  brandGradient.addColorStop(1, "#f2385a");
  roundedRect(ctx, 74, 72, 116, 116, 30);
  ctx.fillStyle = brandGradient;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 64px system-ui, sans-serif";
  ctx.fillText("R", 108, 151);
  ctx.font = "800 56px system-ui, sans-serif";
  ctx.fillText("RexForce 测试报告", 226, 127);
  ctx.fillStyle = "#91a8cf";
  ctx.font = "400 28px system-ui, sans-serif";
  ctx.fillText(reportDate.toLocaleString("zh-CN"), 228, 174);

  roundedRect(ctx, 74, 240, 1252, 164, 28);
  ctx.fillStyle = reportMode === "dual" ? "rgba(215,25,63,.22)" : "rgba(47,109,246,.23)";
  ctx.fill();
  ctx.fillStyle = "#91a8cf";
  ctx.font = "600 26px system-ui, sans-serif";
  ctx.fillText("测试类型", 112, 292);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 54px system-ui, sans-serif";
  const assessmentName = reportAssessment === "cmj" ? "CMJ 反向纵跳" : reportAssessment === "repeat" ? "连续纵跳" : "力量测试";
  ctx.fillText(assessmentName, 112, 363);
  ctx.textAlign = "right";
  ctx.fillStyle = "#91a8cf";
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText(`${reportMode === "dual" ? "双机" : "单机"} · ${summary.duration.toFixed(2)} 秒`, 1286, 337);
  ctx.textAlign = "left";

  const unit = displayUnit();
  if (reportAssessment === "cmj") {
    const cmj = jumpAnalysis.cmj;
    drawReportMetric(ctx, 74, 446, 602, "跳跃高度", cmj ? `${(cmj.jumpHeightM * 100).toFixed(1)} cm` : "未识别", "#f2385a");
    drawReportMetric(ctx, 724, 446, 602, "滞空时间", cmj ? `${Math.round(cmj.flightTime * 1000)} ms` : "未识别", "#3977ff");
    drawReportMetric(ctx, 74, 644, 602, "起跳用时", cmj?.timeToTakeoff ? `${Math.round(cmj.timeToTakeoff * 1000)} ms` : "未识别", "#3977ff");
    drawReportMetric(ctx, 724, 644, 602, "RSImod", cmj?.rsiMod ? `${cmj.rsiMod.toFixed(2)} m/s` : "未识别", "#f2385a");
  } else if (reportAssessment === "repeat") {
    const heights = jumpAnalysis.jumps.map((jump) => jump.jumpHeightM * 100);
    const rsiValues = jumpAnalysis.jumps.map((jump) => jump.rsi).filter(Number.isFinite);
    drawReportMetric(ctx, 74, 446, 602, "有效跳数", `${jumpAnalysis.jumps.length} 跳`, "#f2385a");
    drawReportMetric(ctx, 724, 446, 602, "最佳高度", heights.length ? `${Math.max(...heights).toFixed(1)} cm` : "未识别", "#3977ff");
    drawReportMetric(ctx, 74, 644, 602, "平均高度", heights.length ? `${(heights.reduce((sum, value) => sum + value, 0) / heights.length).toFixed(1)} cm` : "未识别", "#3977ff");
    drawReportMetric(ctx, 724, 644, 602, "最佳 RSI", rsiValues.length ? `${Math.max(...rsiValues).toFixed(2)} m/s` : "未识别", "#f2385a");
  } else {
    drawReportMetric(ctx, 74, 446, 602, "峰值力", `${displayValue(summary.peak).toFixed(1)} ${unit}`, "#f2385a");
    drawReportMetric(ctx, 724, 446, 602, "平均力", `${displayValue(summary.mean).toFixed(1)} ${unit}`, "#3977ff");
    drawReportMetric(ctx, 74, 644, 602, "冲量", `${summary.impulse.toFixed(0)} N·s`, "#3977ff");
    drawReportMetric(ctx, 724, 644, 602, "最大 RFD", `${summary.rfd.toFixed(0)} N/s`, "#f2385a");
  }

  const chartX = 74;
  const chartY = 886;
  const chartWidth = 1252;
  const chartHeight = 580;
  roundedRect(ctx, chartX, chartY, chartWidth, chartHeight, 30);
  ctx.fillStyle = "#091735";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 36px system-ui, sans-serif";
  ctx.fillText("力—时间曲线", chartX + 42, chartY + 64);
  const plotX = chartX + 54;
  const plotY = chartY + 102;
  const plotWidth = chartWidth - 108;
  const plotHeight = chartHeight - 154;
  ctx.strokeStyle = "rgba(221,232,255,.13)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i += 1) {
    const y = plotY + (plotHeight * i) / 4;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotWidth, y); ctx.stroke();
  }
  const reduced = downsample(points, 1000);
  const startTs = reduced[0].timestampMs;
  const endTs = Math.max(startTs + 1, reduced.at(-1).timestampMs);
  const keys = reportMode === "dual"
    ? [["leftKg", "#f2385a", 5], ["rightKg", "#3977ff", 5], ["valueKg", "#ffffff", 7]]
    : [["valueKg", "#ffffff", 7]];
  const maxValue = Math.max(10, ...reduced.flatMap((point) => keys.map(([key]) => Math.max(0, point[key] ?? 0)))) * 1.08;
  for (const [key, color, width] of keys) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    reduced.forEach((point, index) => {
      const x = plotX + ((point.timestampMs - startTs) / (endTs - startTs)) * plotWidth;
      const y = plotY + plotHeight - (Math.max(0, point[key] ?? 0) / maxValue) * plotHeight;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = "#91a8cf";
  ctx.font = "500 24px system-ui, sans-serif";
  ctx.fillText("0 s", plotX, chartY + chartHeight - 24);
  ctx.textAlign = "right";
  ctx.fillText(`${summary.duration.toFixed(2)} s`, plotX + plotWidth, chartY + chartHeight - 24);
  ctx.textAlign = "left";

  let footerY = 1530;
  if (reportMode === "dual") {
    drawReportMetric(ctx, 74, 1510, 602, "左脚峰值", `${displayValue(summary.leftPeak).toFixed(1)} ${unit}`, "#f2385a");
    drawReportMetric(ctx, 724, 1510, 602, "右脚峰值", `${displayValue(summary.rightPeak).toFixed(1)} ${unit}`, "#3977ff");
    footerY = 1770;
  }
  ctx.fillStyle = "#7186aa";
  ctx.font = "400 24px system-ui, sans-serif";
  ctx.fillText("由 RexForce 移动力量台生成 · 数据保存在本机", 74, footerY);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    showToast("图片生成失败", "error");
    return null;
  }
  const filename = `rexforce-report-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  return { blob, filename };
}

function clearExportPreview() {
  if (state.exportPreviewUrl) URL.revokeObjectURL(state.exportPreviewUrl);
  state.exportBlob = null;
  state.exportFilename = "";
  state.exportPreviewUrl = "";
  els.exportPreview.removeAttribute("src");
  els.exportPreviewPanel.hidden = true;
  els.exportOptions.hidden = false;
}

async function showResultImage() {
  els.exportImage.disabled = true;
  els.exportImage.querySelector("strong").textContent = "正在生成图片…";
  let report;
  try {
    report = await buildResultImage();
  } catch (error) {
    showToast(error?.message || "图片生成失败", "error");
  } finally {
    els.exportImage.disabled = false;
    els.exportImage.querySelector("strong").textContent = "预览并保存图片";
  }
  if (!report) return;
  clearExportPreview();
  state.exportBlob = report.blob;
  state.exportFilename = report.filename;
  state.exportPreviewUrl = URL.createObjectURL(report.blob);
  els.exportPreview.src = state.exportPreviewUrl;
  els.exportOptions.hidden = true;
  els.exportPreviewPanel.hidden = false;
  els.exportHint.textContent = "报告图片已生成，可分享、下载或长按保存。";
}

async function shareResultImage() {
  if (!state.exportBlob) return;
  const file = new File([state.exportBlob], state.exportFilename, { type: "image/png" });
  if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) {
    showToast("当前浏览器不支持图片分享，请下载 PNG 或长按图片保存", "error");
    return;
  }
  try {
    await navigator.share({ title: "RexForce 测试报告", files: [file] });
    showToast("结果图片已分享");
  } catch (error) {
    const cancelled = error?.name === "AbortError";
    showToast(cancelled ? "已取消分享，图片仍可下载或长按保存" : "系统分享失败，请下载 PNG 或长按图片保存", cancelled ? "" : "error");
  }
}

function downloadResultImage() {
  if (!state.exportBlob) return;
  downloadBlob(state.exportBlob, state.exportFilename);
  showToast("PNG 图片已下载");
}

function openExportDialog() {
  const points = exportPoints();
  if (!points.length) return showToast("请先完成一次测试", "error");
  clearExportPreview();
  els.exportHint.textContent = state.lastCompletedSamples.length
    ? "将导出最近一次完成的测试，包含核心指标和完整曲线。"
    : "当前尚无已完成测试，将导出实时缓冲中的数据。";
  els.exportDialog.showModal();
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
  if (state.assessment === "strength") {
    els.peak.textContent = `${displayValue(metrics.peak).toFixed(1)} ${unit}`;
    els.mean.textContent = `${displayValue(metrics.mean).toFixed(1)} ${unit}`;
    els.impulse.textContent = `${metrics.impulse.toFixed(0)} N·s`;
    els.rfd.textContent = `${metrics.rfd.toFixed(0)} N/s`;
  } else {
    const jumpSource = state.recording ? state.sessionSamples : state.lastCompletedAssessment === state.assessment ? state.lastCompletedSamples : [];
    if (now - state.lastJumpAnalysisAt >= 180 || state.lastJumpAnalysisAt === 0) {
      state.jumpAnalysis = analyzeJumps(jumpSource);
      state.lastJumpAnalysisAt = now;
    }
    const analysis = state.jumpAnalysis;
    if (state.assessment === "cmj") {
      const cmj = analysis.cmj;
      els.peak.textContent = cmj ? `${(cmj.jumpHeightM * 100).toFixed(1)} cm` : "—";
      els.mean.textContent = cmj ? `${Math.round(cmj.flightTime * 1000)} ms` : "—";
      els.impulse.textContent = cmj?.timeToTakeoff ? `${Math.round(cmj.timeToTakeoff * 1000)} ms` : "—";
      els.rfd.textContent = cmj?.rsiMod ? `${cmj.rsiMod.toFixed(2)} m/s` : "—";
    } else {
      const heights = analysis.jumps.map((jump) => jump.jumpHeightM * 100);
      const rsiValues = analysis.jumps.map((jump) => jump.rsi).filter(Number.isFinite);
      els.peak.textContent = `${analysis.jumps.length}`;
      els.mean.textContent = heights.length ? `${Math.max(...heights).toFixed(1)} cm` : "—";
      els.impulse.textContent = heights.length ? `${(heights.reduce((sum, value) => sum + value, 0) / heights.length).toFixed(1)} cm` : "—";
      els.rfd.textContent = rsiValues.length ? `${Math.max(...rsiValues).toFixed(2)} m/s` : "—";
    }
    if (state.renderedJumpCount !== analysis.jumps.length) {
      renderJumpResults(analysis);
      state.renderedJumpCount = analysis.jumps.length;
    }
  }
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
els.strengthTest.addEventListener("click", () => setAssessment("strength"));
els.cmjTest.addEventListener("click", () => setAssessment("cmj"));
els.repeatJumpTest.addEventListener("click", () => setAssessment("repeat"));
els.demo.addEventListener("click", () => state.demo ? (stopDemo(), setStatus("idle", "等待连接"), els.demoPill.hidden = true) : startDemo());
els.start.addEventListener("click", toggleRecording);
els.tare.addEventListener("click", tare);
els.export.addEventListener("click", openExportDialog);
els.closeExport.addEventListener("click", () => { clearExportPreview(); els.exportDialog.close(); });
els.exportImage.addEventListener("click", showResultImage);
els.exportShare.addEventListener("click", shareResultImage);
els.exportDownload.addEventListener("click", downloadResultImage);
els.exportBack.addEventListener("click", () => {
  clearExportPreview();
  els.exportHint.textContent = "生成包含核心指标和完整力—时间曲线的训练报告。";
});
els.exportCsv.addEventListener("click", exportCsv);
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
setAssessment(state.assessment, false);
updateDashboard();
