(() => {
  const $ = (id) => document.getElementById(id);

  const dropzone = $("dropzone");
  const pickBtn = $("pickBtn");
  const fileInput = $("fileInput");

  const formatSelect = $("formatSelect");
  const limitResize = $("limitResize");
  const maxDimInput = $("maxDim");
  const qualityRange = $("quality");
  const qualityValue = $("qualityValue");
  const qualityHelp = $("qualityHelp");

  const compressBtn = $("compressBtn");
  const resetBtn = $("resetBtn");
  const statusEl = $("status");

  const originalPreview = $("originalPreview");
  const compressedPreview = $("compressedPreview");
  const originalPlaceholder = $("originalPlaceholder");
  const compressedPlaceholder = $("compressedPlaceholder");

  const originalFileName = $("originalFileName");
  const originalSizeEl = $("originalSize");
  const originalDimsEl = $("originalDims");
  const compressedSizeEl = $("compressedSize");
  const savedPctEl = $("savedPct");

  const downloadBtn = $("downloadBtn");
  const downloadHint = $("downloadHint");

  const overlay = $("overlay");
  const overlayText = $("overlayText");

  // Single reusable canvas instance for performance.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });

  const state = {
    file: null,
    img: null,
    originalUrl: null,
    compressedUrl: null,
    originalBytes: 0,
    compressToken: 0,
    scheduleTimer: null,
  };

  const canWebp = (() => {
    try {
      const c = document.createElement("canvas");
      const data = c.toDataURL("image/webp");
      return data.startsWith("data:image/webp");
    } catch {
      return false;
    }
  })();

  function setOverlay(visible, text) {
    overlayText.textContent = text || "压缩中…";
    overlay.classList.toggle("hidden", !visible);
  }

  function setStatus(text, tone) {
    // tone is reserved for future styling; keep minimal now.
    statusEl.textContent = text || "";
    if (tone === "danger") statusEl.style.color = "rgba(255, 77, 109, 0.95)";
    else statusEl.style.color = "var(--muted)";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    const units = ["B", "KB", "MB", "GB"];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, idx);
    const digits = idx === 0 ? 0 : idx === 1 ? 1 : 2;
    return `${val.toFixed(digits)} ${units[idx]}`;
  }

  function formatNumber(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
  }

  function resolveOutputMime() {
    const v = formatSelect.value;
    if (v === "auto") return canWebp ? "image/webp" : "image/jpeg";
    if (v === "webp") return canWebp ? "image/webp" : "image/jpeg";
    if (v === "jpeg") return "image/jpeg";
    return "image/png";
  }

  function outputExtFromMime(mime) {
    if (mime === "image/webp") return "webp";
    if (mime === "image/jpeg") return "jpg";
    if (mime === "image/png") return "png";
    return "img";
  }

  function updateQualityUI() {
    const mime = resolveOutputMime();
    const isPng = mime === "image/png";
    qualityRange.disabled = isPng;
    const q = Number(qualityRange.value);
    qualityValue.textContent = q.toFixed(2);
    if (isPng) {
      qualityHelp.textContent = "PNG 输出：质量不会生效（Canvas toBlob 不提供质量参数）。压缩主要来自缩放。";
    } else {
      qualityHelp.textContent = "质量越低，体积通常越小（画质也会更“糊”一点）。";
    }
  }

  function resetAll() {
    state.file = null;
    state.img = null;
    state.originalBytes = 0;
    state.compressToken++;

    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.compressedUrl) URL.revokeObjectURL(state.compressedUrl);
    state.originalUrl = null;
    state.compressedUrl = null;

    if (state.scheduleTimer) clearTimeout(state.scheduleTimer);
    state.scheduleTimer = null;

    originalPreview.removeAttribute("src");
    compressedPreview.removeAttribute("src");
    originalPreview.hidden = true;
    compressedPreview.hidden = true;
    originalPlaceholder.hidden = false;
    compressedPlaceholder.hidden = false;

    originalFileName.textContent = "-";
    originalSizeEl.textContent = "-";
    originalDimsEl.textContent = "-";
    compressedSizeEl.textContent = "-";
    savedPctEl.textContent = "-";

    downloadBtn.href = "#";
    downloadBtn.classList.add("disabled");
    downloadHint.textContent = "等待你上传图片后开始压缩。";

    setStatus("");
    compressBtn.disabled = true;
    resetBtn.disabled = true;
  }

  async function setImageFromFile(file) {
    // Clean previous URLs.
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.compressedUrl) URL.revokeObjectURL(state.compressedUrl);
    state.compressedUrl = null;

    state.file = file;
    state.originalBytes = file.size;

    originalFileName.textContent = file.name || "-";
    originalSizeEl.textContent = formatBytes(file.size);

    setOverlay(true, "载入图片…");
    setStatus("");

    state.originalUrl = URL.createObjectURL(file);
    originalPreview.src = state.originalUrl;
    originalPreview.hidden = false;
    originalPlaceholder.hidden = true;

    const img = new Image();
    img.decoding = "async";
    state.img = null;

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = state.originalUrl;
    });

    state.img = img;
    originalDimsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;

    // Enable actions and attempt compression immediately.
    compressBtn.disabled = false;
    resetBtn.disabled = false;
    setOverlay(false);
  }

  function scheduleCompress() {
    if (!state.img) return;
    if (state.scheduleTimer) clearTimeout(state.scheduleTimer);
    state.scheduleTimer = setTimeout(() => {
      compressNow().catch((err) => setStatus(err?.message || "压缩失败", "danger"));
    }, 350);
  }

  async function canvasToBlobAsync(mime, quality) {
    return await new Promise((resolve, reject) => {
      if (!canvas.toBlob) {
        reject(new Error("你的浏览器不支持 canvas.toBlob"));
        return;
      }
      const q = mime === "image/jpeg" || mime === "image/webp" ? quality : undefined;
      if (typeof q === "number") canvas.toBlob(resolve, mime, q);
      else canvas.toBlob(resolve, mime);
    });
  }

  async function compressNow() {
    if (!state.img || !state.file) return;

    const jobId = ++state.compressToken;
    setOverlay(true, "压缩中…");
    compressBtn.disabled = true;
    resetBtn.disabled = true;
    downloadBtn.classList.add("disabled");
    downloadHint.textContent = "压缩完成后会自动解锁下载。";

    try {
      const ow = state.img.naturalWidth || state.img.width;
      const oh = state.img.naturalHeight || state.img.height;
      if (!ow || !oh) throw new Error("图片尺寸异常");

      const mime = resolveOutputMime();
      const q = Number(qualityRange.value);

      let scale = 1;
      if (limitResize.checked) {
        const maxDim = parseInt(maxDimInput.value, 10);
        const maxSide = Math.max(ow, oh);
        if (Number.isFinite(maxDim) && maxDim > 0) {
          scale = Math.min(1, maxDim / maxSide);
        }
      }

      const w = Math.max(1, Math.round(ow * scale));
      const h = Math.max(1, Math.round(oh * scale));

      canvas.width = w;
      canvas.height = h;

      ctx.clearRect(0, 0, w, h);
      // JPEG 不支持透明通道；在绘制前用白色底，避免透明区域变黑。
      if (mime === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(state.img, 0, 0, w, h);

      const blob = await canvasToBlobAsync(mime, q);
      if (jobId !== state.compressToken) return; // outdated
      if (!blob) throw new Error("压缩失败（可能不支持该输出格式）");

      if (state.compressedUrl) URL.revokeObjectURL(state.compressedUrl);
      state.compressedUrl = URL.createObjectURL(blob);

      compressedPreview.src = state.compressedUrl;
      compressedPreview.hidden = false;
      compressedPlaceholder.hidden = true;

      const compressedBytes = blob.size;
      compressedSizeEl.textContent = formatBytes(compressedBytes);

      const saved = Math.max(0, state.originalBytes - compressedBytes);
      const pct = state.originalBytes > 0 ? Math.round((saved / state.originalBytes) * 100) : 0;
      savedPctEl.textContent = pct <= 0 ? "—" : `${pct}%`;

      // Update download link.
      const name = state.file.name || "image";
      const base = name.replace(/\.[^.]+$/, "");
      const ext = outputExtFromMime(mime);
      downloadBtn.href = state.compressedUrl;
      downloadBtn.download = `${base}_compressed.${ext}`;
      downloadBtn.classList.remove("disabled");

      setStatus(
        `完成：${formatBytes(state.originalBytes)} → ${formatBytes(compressedBytes)}`,
        compressedBytes < state.originalBytes ? "ok" : undefined
      );
    } catch (err) {
      if (jobId !== state.compressToken) return;
      setStatus(err?.message || "压缩失败", "danger");
      compressedPreview.hidden = true;
      compressedPlaceholder.hidden = false;
    } finally {
      if (jobId !== state.compressToken) return;
      setOverlay(false);
      compressBtn.disabled = !state.img;
      resetBtn.disabled = !state.img;
      downloadHint.textContent = state.compressedUrl ? "可以点击下载了。" : "等待你上传图片后开始压缩。";
    }
  }

  function acceptAndMaybeCompress(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      setStatus("请选择图片文件（image/*）。", "danger");
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setStatus("图片较大（>30MB）。建议先开启“限制最大尺寸”。", "danger");
    } else {
      setStatus("");
    }

    setImageFromFile(file)
      .then(() => {
        updateQualityUI();
        setStatus("");
        // 自动首次压缩，让用户上传后能立刻看到效果。
        scheduleCompress();
      })
      .catch((err) => {
        setStatus(err?.message || "加载图片失败", "danger");
      });
  }

  function onFiles(files) {
    const file = files && files[0];
    acceptAndMaybeCompress(file);
  }

  // Events: upload, drag & drop.
  pickBtn.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target === dropzone || e.target === pickBtn) fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });

  fileInput.addEventListener("change", () => onFiles(fileInput.files));

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      onFiles(dt.files);
    }
  });

  // Events: settings.
  formatSelect.addEventListener("change", () => {
    updateQualityUI();
    scheduleCompress();
  });
  limitResize.addEventListener("change", () => scheduleCompress());
  maxDimInput.addEventListener("input", () => scheduleCompress());
  qualityRange.addEventListener("input", () => {
    qualityValue.textContent = Number(qualityRange.value).toFixed(2);
    scheduleCompress();
  });

  compressBtn.addEventListener("click", () => {
    compressNow().catch((err) => setStatus(err?.message || "压缩失败", "danger"));
  });

  resetBtn.addEventListener("click", resetAll);

  // Init.
  updateQualityUI();
  downloadBtn.classList.add("disabled");
  resetAll();
})();

