(() => {
  "use strict";

  const els = {
    app: document.getElementById("app"),
    accessGate: document.getElementById("accessGate"),
    accessForm: document.getElementById("accessForm"),
    accessTitle: document.getElementById("accessTitle"),
    accessIntro: document.getElementById("accessIntro"),
    accessPasswordInput: document.getElementById("accessPasswordInput"),
    accessConfirmWrap: document.getElementById("accessConfirmWrap"),
    accessPasswordConfirmInput: document.getElementById("accessPasswordConfirmInput"),
    accessSubmitBtn: document.getElementById("accessSubmitBtn"),
    accessStatus: document.getElementById("accessStatus"),
    accessVersionBadge: document.getElementById("accessVersionBadge"),
    versionBadge: document.getElementById("versionBadge"),
    status: document.getElementById("status"),
    cookieCount: document.getElementById("cookieCount"),
    siteCount: document.getElementById("siteCount"),
    tabCount: document.getElementById("tabCount"),
    storeCount: document.getElementById("storeCount"),
    scanBtn: document.getElementById("scanBtn"),
    passphraseInput: document.getElementById("passphraseInput"),
    exportFileBtn: document.getElementById("exportFileBtn"),
    copyPackageBtn: document.getElementById("copyPackageBtn"),
    importFileInput: document.getElementById("importFileInput"),
    importTextInput: document.getElementById("importTextInput"),
    openTabsCheckbox: document.getElementById("openTabsCheckbox"),
    clearImportBtn: document.getElementById("clearImportBtn"),
    importBtn: document.getElementById("importBtn")
  };

  const TRANSFER_FORMAT = "cookie-editor-pro-transfer";
  const ENCRYPTED_TRANSFER_FORMAT = "cookie-editor-pro-encrypted-transfer";
  const ACCESS_LOCK_FORMAT = "cookie-editor-pro-access-lock";
  const ACCESS_LOCK_KEY = "cookieEditorAccessLock";
  const ACCESS_RATE_KEY = "cookieEditorAccessRate";
  const DEFAULT_ACCESS_PASSWORD = "11022";
  const DEFAULT_ACCESS_PRESET = "HI-default-access-v1";
  const TRANSFER_VERSION = 1;
  const PBKDF2_ITERATIONS = 250000;
  const ACCESS_LOCK_VERSION = 1;
  const ACCESS_MAX_ATTEMPTS = 5;
  const ACCESS_LOCKOUT_MS = 30000;
  const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
  const numberFormat = new Intl.NumberFormat("vi-VN");

  const state = {
    cookies: [],
    windows: [],
    stores: [],
    warnings: [],
    sourceContext: null
  };

  let accessUnlocked = false;
  let accessMode = "loading";
  let accessRecord = null;
  let accessRate = { failedAttempts: 0, lockUntil: 0 };
  let accessBusy = false;
  let accessLockoutTimer = null;

  const actionButtons = [
    els.scanBtn,
    els.exportFileBtn,
    els.copyPackageBtn,
    els.importBtn
  ];

  const setStatus = (message, kind = "idle", detail = "") => {
    els.status.textContent = message;
    els.status.dataset.kind = kind;
    els.status.title = detail;
  };

  const setBusy = (busy) => {
    for (const button of actionButtons) {
      button.disabled = busy;
    }
  };

  const formatCount = (value) => numberFormat.format(Number(value) || 0);

  const isSupportedUrl = (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  };

  const normalizeHost = (value) => {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");
  };

  const normalizePath = (value) => {
    const path = String(value || "/").trim();
    if (!path) return "/";
    return path.startsWith("/") ? path : `/${path}`;
  };

  const normalizeSameSite = (value) => {
    const normalized = String(value || "unspecified").trim().toLowerCase();
    if (normalized === "no_restriction") return "none";
    return ["none", "lax", "strict", "unspecified"].includes(normalized)
      ? normalized
      : "unspecified";
  };

  const toChromeSameSite = (value) => {
    const normalized = normalizeSameSite(value);
    return normalized === "none" ? "no_restriction" : normalized;
  };

  const normalizePartitionKey = (value) => {
    if (!value || typeof value !== "object") return undefined;
    const topLevelSite = typeof value.topLevelSite === "string"
      ? value.topLevelSite.trim()
      : "";
    if (!topLevelSite) return undefined;

    const partitionKey = { topLevelSite };
    if (typeof value.hasCrossSiteAncestor === "boolean") {
      partitionKey.hasCrossSiteAncestor = value.hasCrossSiteAncestor;
    }
    return partitionKey;
  };

  const serializeCookie = (cookie) => {
    const serialized = {
      name: cookie.name == null ? "" : String(cookie.name),
      value: cookie.value == null ? "" : String(cookie.value),
      domain: normalizeHost(cookie.domain),
      path: normalizePath(cookie.path),
      hostOnly: !!cookie.hostOnly,
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: normalizeSameSite(cookie.sameSite),
      session: !!cookie.session
    };

    if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)) {
      serialized.expirationDate = cookie.expirationDate;
    }
    if (cookie.storeId != null) {
      serialized.storeId = String(cookie.storeId);
    }
    const partitionKey = normalizePartitionKey(cookie.partitionKey);
    if (partitionKey) {
      serialized.partitionKey = partitionKey;
    }
    return serialized;
  };

  const normalizeImportCookie = (raw) => {
    if (!raw || typeof raw !== "object") return null;

    const cookie = {
      name: raw.name == null ? "" : String(raw.name),
      value: raw.value == null ? "" : String(raw.value),
      domain: normalizeHost(raw.domain),
      path: normalizePath(raw.path),
      hostOnly: raw.hostOnly === true || raw.host_only === true,
      secure: !!raw.secure,
      httpOnly: !!raw.httpOnly || !!raw.http_only,
      sameSite: normalizeSameSite(raw.sameSite || raw.same_site),
      session: raw.session === true
    };

    const expiration = typeof raw.expirationDate === "number"
      ? raw.expirationDate
      : Number(raw.expirationDate);
    if (Number.isFinite(expiration) && expiration > 0) {
      cookie.expirationDate = expiration;
    } else {
      cookie.session = true;
    }
    if (raw.storeId != null) {
      cookie.storeId = String(raw.storeId);
    }
    const partitionKey = normalizePartitionKey(raw.partitionKey || raw.partition_key);
    if (partitionKey) {
      cookie.partitionKey = partitionKey;
    }
    return cookie;
  };

  const cookieIdentity = (cookie, includeStore = true) => {
    const partitionKey = normalizePartitionKey(cookie.partitionKey);
    return JSON.stringify([
      includeStore && cookie.storeId != null ? String(cookie.storeId) : "",
      normalizeHost(cookie.domain),
      normalizePath(cookie.path),
      cookie.name == null ? "" : String(cookie.name),
      partitionKey?.topLevelSite || "",
      partitionKey?.hasCrossSiteAncestor ?? null
    ]);
  };

  const dedupeCookies = (cookies, includeStore = true) => {
    const unique = new Map();
    for (const cookie of cookies) {
      unique.set(cookieIdentity(cookie, includeStore), cookie);
    }
    return [...unique.values()];
  };

  const getCookiesForFilter = async (filter) => {
    const warnings = [];
    const unpartitioned = await chrome.cookies.getAll(filter);
    let combined = [...unpartitioned];

    try {
      const includingPartitioned = await chrome.cookies.getAll({ ...filter, partitionKey: {} });
      combined.push(...includingPartitioned);
    } catch (error) {
      warnings.push(`Không quét được cookie CHIPS: ${error?.message || "không hỗ trợ"}`);
    }

    return { cookies: dedupeCookies(combined), warnings };
  };

  const scanActiveProfileStore = async () => {
    const activeTab = await getOptionalActiveTab();
    if (!activeTab?.id) {
      throw new Error("Không xác định được profile nguồn. Hãy mở một tab trong profile cần xuất.");
    }

    let stores;
    try {
      stores = await chrome.cookies.getAllCookieStores();
    } catch (error) {
      throw new Error(`Không đọc được danh sách kho cookie: ${error?.message || "lỗi trình duyệt"}`);
    }

    let sourceStore = stores.find((store) => store.tabIds?.includes(activeTab.id));
    if (!sourceStore && stores.length === 1) {
      sourceStore = stores[0];
    }
    if (!sourceStore) {
      throw new Error("Không xác định được kho cookie nguồn. Hãy mở tab web trong đúng profile rồi thử lại.");
    }

    setStatus(`Đang quét kho cookie của profile hiện tại…`, "working");
    let result;
    try {
      result = await getCookiesForFilter({ storeId: sourceStore.id });
    } catch (error) {
      throw new Error(`Không quét được kho cookie ${sourceStore.id}: ${error?.message || "lỗi trình duyệt"}`);
    }

    return {
      cookies: result.cookies,
      stores: [sourceStore],
      warnings: result.warnings.map((message) => `Kho ${sourceStore.id}: ${message}`),
      sourceContext: {
        storeId: String(sourceStore.id),
        incognito: !!activeTab.incognito
      }
    };
  };

  const getOptionalActiveTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  };

  const captureOpenWindows = async () => {
    const activeTab = await getOptionalActiveTab();
    const incognitoContext = !!activeTab?.incognito;
    const browserWindows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });

    return browserWindows
      .filter((browserWindow) => !!browserWindow.incognito === incognitoContext)
      .map((browserWindow) => ({
        state: browserWindow.state || "normal",
        tabs: (browserWindow.tabs || [])
          .map((tab) => ({
            url: tab.url || tab.pendingUrl || "",
            title: tab.title || "",
            pinned: !!tab.pinned,
            active: !!tab.active,
            index: Number.isInteger(tab.index) ? tab.index : 0
          }))
          .filter((tab) => isSupportedUrl(tab.url))
      }))
      .filter((browserWindow) => browserWindow.tabs.length > 0);
  };

  const countTabs = (windows) => {
    return (windows || []).reduce((total, browserWindow) => {
      return total + (Array.isArray(browserWindow?.tabs) ? browserWindow.tabs.length : 0);
    }, 0);
  };

  const countSites = (cookies) => {
    return new Set(cookies.map((cookie) => normalizeHost(cookie.domain)).filter(Boolean)).size;
  };

  const updateStats = () => {
    els.cookieCount.textContent = formatCount(state.cookies.length);
    els.siteCount.textContent = formatCount(countSites(state.cookies));
    els.tabCount.textContent = formatCount(countTabs(state.windows));
    els.storeCount.textContent = formatCount(state.stores.length || (state.cookies.length ? 1 : 0));
  };

  const requireAccessUnlocked = () => {
    if (!accessUnlocked) {
      throw new Error("Extension đang khóa. Hãy nhập mật khẩu truy cập trước.");
    }
  };

  const scanProfile = async () => {
    requireAccessUnlocked();
    setStatus("Đang quét toàn bộ cookie và tab của profile…", "working");
    const cookieResult = await scanActiveProfileStore();
    const warnings = [...cookieResult.warnings];
    let windows = [];

    try {
      windows = await captureOpenWindows();
    } catch (error) {
      warnings.push(`Không lấy được danh sách tab: ${error?.message || "lỗi trình duyệt"}`);
    }

    state.cookies = cookieResult.cookies;
    state.stores = cookieResult.stores;
    state.windows = windows;
    state.warnings = warnings;
    state.sourceContext = cookieResult.sourceContext;
    updateStats();

    const summary = `${formatCount(state.cookies.length)} cookie, ${formatCount(countTabs(windows))} tab`;
    if (warnings.length) {
      setStatus(
        `Quét một phần: ${summary}. Có ${warnings.length} cảnh báo.`,
        "warning",
        warnings.join("\n")
      );
    } else {
      setStatus(`Đã quét xong: ${summary}.`, "success");
    }

    return {
      cookies: state.cookies.map(serializeCookie),
      windows: state.windows,
      stores: state.stores,
      warnings: state.warnings,
      sourceContext: state.sourceContext
    };
  };

  const bytesToBase64 = (bytes) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  };

  const base64ToBytes = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const setAccessStatus = (message, kind = "idle") => {
    els.accessStatus.textContent = message;
    els.accessStatus.dataset.kind = kind;
  };

  const normalizeAccessRate = (value) => {
    const failedAttempts = Number(value?.failedAttempts);
    const lockUntil = Number(value?.lockUntil);
    return {
      failedAttempts: Number.isInteger(failedAttempts) && failedAttempts >= 0
        ? Math.min(failedAttempts, ACCESS_MAX_ATTEMPTS - 1)
        : 0,
      lockUntil: Number.isFinite(lockUntil) && lockUntil > 0 ? lockUntil : 0
    };
  };

  const accessLockRemaining = () => Math.max(0, accessRate.lockUntil - Date.now());

  const updateAccessControls = () => {
    const remaining = accessLockRemaining();
    const unavailable = accessMode === "loading" || accessMode === "error";
    const disabled = unavailable || accessBusy || remaining > 0;
    els.accessPasswordInput.disabled = disabled;
    els.accessPasswordConfirmInput.disabled = disabled;
    els.accessSubmitBtn.disabled = disabled;

    if (remaining > 0) {
      setAccessStatus(
        `Quá nhiều lần nhập sai. Thử lại sau ${Math.ceil(remaining / 1000)} giây.`,
        "warning"
      );
      if (!accessLockoutTimer) {
        accessLockoutTimer = setInterval(updateAccessControls, 1000);
      }
      return;
    }

    if (accessLockoutTimer) {
      clearInterval(accessLockoutTimer);
      accessLockoutTimer = null;
    }
    if (accessRate.lockUntil) {
      accessRate.lockUntil = 0;
      setAccessStatus("Bạn có thể thử lại.", "idle");
    }
  };

  const renderAccessMode = () => {
    els.accessGate.hidden = false;
    els.app.hidden = true;
    els.app.setAttribute("aria-hidden", "true");
    els.accessPasswordInput.value = "";
    els.accessPasswordConfirmInput.value = "";

    if (accessMode === "setup") {
      els.accessTitle.textContent = "Tạo mật khẩu truy cập";
      els.accessIntro.textContent = "Lần đầu sử dụng: tạo mật khẩu để khóa phần xuất và nhập dữ liệu.";
      els.accessConfirmWrap.hidden = false;
      els.accessSubmitBtn.textContent = "Tạo mật khẩu và mở khóa";
      setAccessStatus("Mật khẩu cần tối thiểu 8 ký tự.", "idle");
    } else if (accessMode === "unlock") {
      els.accessTitle.textContent = "Mở khóa extension";
      els.accessIntro.textContent = "Nhập mật khẩu truy cập để dùng phần chuyển cookie và phiên.";
      els.accessConfirmWrap.hidden = true;
      els.accessSubmitBtn.textContent = "Mở khóa";
      setAccessStatus("Popup sẽ tự khóa lại sau khi đóng.", "idle");
    }

    updateAccessControls();
    if (!els.accessPasswordInput.disabled) {
      els.accessPasswordInput.focus();
    }
  };

  const showTransferApp = () => {
    accessUnlocked = true;
    if (accessLockoutTimer) {
      clearInterval(accessLockoutTimer);
      accessLockoutTimer = null;
    }
    els.accessPasswordInput.value = "";
    els.accessPasswordConfirmInput.value = "";
    els.accessGate.hidden = true;
    els.app.hidden = false;
    els.app.setAttribute("aria-hidden", "false");
  };

  const accessRecordIsValid = (record) => {
    if (record?.format !== ACCESS_LOCK_FORMAT || record?.version !== ACCESS_LOCK_VERSION) return false;
    if (record.kdf?.name !== "PBKDF2" || record.kdf?.hash !== "SHA-256") return false;
    const iterations = Number(record.kdf?.iterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
    try {
      return base64ToBytes(record.kdf.salt).length === 16 &&
        base64ToBytes(record.verifier).length === 32;
    } catch {
      return false;
    }
  };

  const deriveAccessVerifier = async (passphrase, salt, iterations) => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material,
        256
      )
    );
  };

  const accessVerifiersMatch = (actual, expected) => {
    if (actual.length !== expected.length) return false;
    let mismatch = 0;
    for (let index = 0; index < actual.length; index++) {
      mismatch |= actual[index] ^ expected[index];
    }
    return mismatch === 0;
  };

  const createAccessRecord = async (passphrase) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const verifier = await deriveAccessVerifier(passphrase, salt, PBKDF2_ITERATIONS);
    return {
      format: ACCESS_LOCK_FORMAT,
      version: ACCESS_LOCK_VERSION,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: bytesToBase64(salt)
      },
      verifier: bytesToBase64(verifier)
    };
  };

  const createDefaultAccessRecord = async () => {
    const record = await createAccessRecord(DEFAULT_ACCESS_PASSWORD);
    record.preset = DEFAULT_ACCESS_PRESET;
    return record;
  };

  const verifyAccessPassphrase = async (passphrase) => {
    const salt = base64ToBytes(accessRecord.kdf.salt);
    const expected = base64ToBytes(accessRecord.verifier);
    const actual = await deriveAccessVerifier(passphrase, salt, Number(accessRecord.kdf.iterations));
    return accessVerifiersMatch(actual, expected);
  };

  const registerFailedAccess = async () => {
    const failedAttempts = accessRate.failedAttempts + 1;
    if (failedAttempts >= ACCESS_MAX_ATTEMPTS) {
      accessRate = { failedAttempts: 0, lockUntil: Date.now() + ACCESS_LOCKOUT_MS };
      await chrome.storage.local.set({ [ACCESS_RATE_KEY]: accessRate });
      return "Sai mật khẩu. Extension tạm khóa trong 30 giây.";
    }

    accessRate = { failedAttempts, lockUntil: 0 };
    await chrome.storage.local.set({ [ACCESS_RATE_KEY]: accessRate });
    return `Sai mật khẩu. Còn ${ACCESS_MAX_ATTEMPTS - failedAttempts} lần thử trước khi tạm khóa.`;
  };

  const handleAccessSubmit = async () => {
    if (accessMode !== "setup" && accessMode !== "unlock") {
      throw new Error("Khóa truy cập chưa sẵn sàng.");
    }
    if (accessLockRemaining() > 0) {
      throw new Error(`Hãy thử lại sau ${Math.ceil(accessLockRemaining() / 1000)} giây.`);
    }

    const passphrase = els.accessPasswordInput.value;
    if (!passphrase.length) {
      throw new Error("Hãy nhập mật khẩu truy cập.");
    }
    if (accessMode === "setup" && passphrase.length < 8) {
      throw new Error("Mật khẩu truy cập phải có ít nhất 8 ký tự.");
    }
    if (passphrase.length > 256) {
      throw new Error("Mật khẩu truy cập dài tối đa 256 ký tự.");
    }

    if (accessMode === "setup") {
      if (passphrase !== els.accessPasswordConfirmInput.value) {
        throw new Error("Hai lần nhập mật khẩu chưa khớp.");
      }
      setAccessStatus("Đang tạo khóa truy cập…", "working");
      const record = await createAccessRecord(passphrase);
      const emptyRate = { failedAttempts: 0, lockUntil: 0 };
      await chrome.storage.local.set({
        [ACCESS_LOCK_KEY]: record,
        [ACCESS_RATE_KEY]: emptyRate
      });
      accessRecord = record;
      accessRate = emptyRate;
      showTransferApp();
      return;
    }

    setAccessStatus("Đang kiểm tra mật khẩu…", "working");
    if (!await verifyAccessPassphrase(passphrase)) {
      throw new Error(await registerFailedAccess());
    }
    accessRate = { failedAttempts: 0, lockUntil: 0 };
    await chrome.storage.local.set({ [ACCESS_RATE_KEY]: accessRate });
    showTransferApp();
  };

  const runAccessAction = async (action) => {
    accessBusy = true;
    updateAccessControls();
    try {
      await action();
    } catch (error) {
      setAccessStatus(error?.message || "Không thể mở khóa extension.", "error");
    } finally {
      accessBusy = false;
      updateAccessControls();
    }
  };

  const initializeAccessGate = async () => {
    accessMode = "loading";
    updateAccessControls();
    let stored;
    try {
      stored = await chrome.storage.local.get([ACCESS_LOCK_KEY, ACCESS_RATE_KEY]);
    } catch (error) {
      accessMode = "error";
      els.accessTitle.textContent = "Không đọc được khóa truy cập";
      els.accessIntro.textContent = "Extension đã giữ trạng thái khóa để bảo vệ dữ liệu.";
      setAccessStatus(error?.message || "Chrome Storage không khả dụng.", "error");
      updateAccessControls();
      return;
    }

    const storedRecord = stored[ACCESS_LOCK_KEY];
    accessRate = normalizeAccessRate(stored[ACCESS_RATE_KEY]);
    if (storedRecord != null && !accessRecordIsValid(storedRecord)) {
      accessMode = "error";
      els.accessTitle.textContent = "Dữ liệu khóa bị hỏng";
      els.accessIntro.textContent = "Extension không tự bỏ qua mật khẩu. Hãy gỡ rồi cài lại nếu bạn cần tạo khóa mới.";
      setAccessStatus("Không thể xác minh cấu trúc khóa đã lưu.", "error");
      updateAccessControls();
      return;
    }

    if (storedRecord == null || storedRecord.preset !== DEFAULT_ACCESS_PRESET) {
      try {
        setAccessStatus("Đang cấu hình mật khẩu mặc định…", "working");
        const defaultRecord = await createDefaultAccessRecord();
        const emptyRate = { failedAttempts: 0, lockUntil: 0 };
        await chrome.storage.local.set({
          [ACCESS_LOCK_KEY]: defaultRecord,
          [ACCESS_RATE_KEY]: emptyRate
        });
        accessRecord = defaultRecord;
        accessRate = emptyRate;
        accessMode = "unlock";
        renderAccessMode();
      } catch (error) {
        accessMode = "error";
        els.accessTitle.textContent = "Không tạo được khóa truy cập";
        els.accessIntro.textContent = "Extension đã giữ trạng thái khóa để bảo vệ dữ liệu.";
        setAccessStatus(error?.message || "Chrome Storage không khả dụng.", "error");
        updateAccessControls();
      }
      return;
    }

    accessRecord = storedRecord;
    accessMode = "unlock";
    renderAccessMode();
  };

  const deriveTransferKey = async (passphrase, salt, iterations, usages) => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );
  };

  const encryptTransfer = async (payload, passphrase) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveTransferKey(passphrase, salt, PBKDF2_ITERATIONS, ["encrypt"]);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
    );

    return JSON.stringify({
      format: ENCRYPTED_TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: bytesToBase64(salt)
      },
      cipher: {
        name: "AES-GCM",
        iv: bytesToBase64(iv)
      },
      data: bytesToBase64(ciphertext)
    });
  };

  const decryptTransfer = async (text, passphrase) => {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error("File/gói chuyển không phải JSON hợp lệ.");
    }

    if (envelope?.format !== ENCRYPTED_TRANSFER_FORMAT || envelope?.version !== TRANSFER_VERSION) {
      throw new Error("Đây không phải gói .cepx được hỗ trợ.");
    }
    if (envelope.kdf?.name !== "PBKDF2" || envelope.kdf?.hash !== "SHA-256") {
      throw new Error("Thuật toán tạo khóa không được hỗ trợ.");
    }
    if (envelope.cipher?.name !== "AES-GCM") {
      throw new Error("Thuật toán mã hóa không được hỗ trợ.");
    }

    const iterations = Number(envelope.kdf.iterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) {
      throw new Error("Thông số bảo vệ mật khẩu không hợp lệ.");
    }

    try {
      const salt = base64ToBytes(envelope.kdf.salt);
      const iv = base64ToBytes(envelope.cipher.iv);
      const ciphertext = base64ToBytes(envelope.data);
      const key = await deriveTransferKey(passphrase, salt, iterations, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));

      if (payload?.format !== TRANSFER_FORMAT || payload?.version !== TRANSFER_VERSION) {
        throw new Error("Nội dung gói chuyển không được hỗ trợ.");
      }
      return payload;
    } catch (error) {
      if (error?.message === "Nội dung gói chuyển không được hỗ trợ.") throw error;
      throw new Error("Sai mật khẩu hoặc gói chuyển đã bị hỏng.");
    }
  };

  const getPassphrase = () => {
    const passphrase = els.passphraseInput.value;
    if (passphrase.length < 8) {
      throw new Error("Mật khẩu bảo vệ phải có ít nhất 8 ký tự.");
    }
    return passphrase;
  };

  const createTransferPayload = async () => {
    const snapshot = await scanProfile();
    if (snapshot.warnings.length) {
      const proceed = confirm(
        `Quét có ${snapshot.warnings.length} cảnh báo nên gói có thể chưa đầy đủ. Bạn vẫn muốn tiếp tục?`
      );
      if (!proceed) {
        throw new Error("Đã hủy vì quá trình quét chưa đầy đủ.");
      }
    }

    return {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      exportedAt: new Date().toISOString(),
      cookies: snapshot.cookies,
      windows: snapshot.windows,
      sourceContext: snapshot.sourceContext,
      scan: {
        complete: snapshot.warnings.length === 0,
        warnings: snapshot.warnings
      }
    };
  };

  const timestamp = () => {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "T",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  };

  const downloadText = (text, filename) => {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      els.importTextInput.value = text;
      els.importTextInput.focus();
      els.importTextInput.select();
      throw new Error("Không copy tự động được. Gói đã được đưa vào ô nhập để bạn copy thủ công.");
    }
  };

  const exportEncryptedFile = async () => {
    requireAccessUnlocked();
    const passphrase = getPassphrase();
    const payload = await createTransferPayload();
    setStatus("Đang mã hóa và tạo file…", "working");
    const encrypted = await encryptTransfer(payload, passphrase);
    downloadText(encrypted, `HI-transfer-${timestamp()}.cepx`);
    els.passphraseInput.value = "";
    setStatus(
      `Đã tạo file: ${formatCount(payload.cookies.length)} cookie, ${formatCount(countTabs(payload.windows))} tab.`,
      "success"
    );
  };

  const copyEncryptedPackage = async () => {
    requireAccessUnlocked();
    const passphrase = getPassphrase();
    const payload = await createTransferPayload();
    setStatus("Đang mã hóa gói để copy…", "working");
    const encrypted = await encryptTransfer(payload, passphrase);
    await copyText(encrypted);
    els.passphraseInput.value = "";
    setStatus(
      `Đã copy gói mã hóa: ${formatCount(payload.cookies.length)} cookie, ${formatCount(countTabs(payload.windows))} tab.`,
      "success"
    );
  };

  const readFileText = async (file) => {
    if (file.size > MAX_IMPORT_BYTES) {
      throw new Error("File lớn hơn giới hạn 100 MB.");
    }
    return file.text();
  };

  const getImportSource = async () => {
    const file = els.importFileInput.files?.[0];
    if (file) {
      return { text: await readFileText(file), sourceName: file.name || "file" };
    }
    const pasted = els.importTextInput.value.trim();
    if (pasted) {
      if (pasted.length > MAX_IMPORT_BYTES) {
        throw new Error("Nội dung dán lớn hơn giới hạn 100 MB.");
      }
      return { text: pasted, sourceName: "clipboard" };
    }
    throw new Error("Hãy chọn file .cepx hoặc dán gói đã copy.");
  };

  const parseImportPayload = async (text, sourceName = "") => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("File hoặc nội dung dán không phải JSON hợp lệ.");
    }

    if (sourceName.toLowerCase().endsWith(".cepx") && parsed?.format !== ENCRYPTED_TRANSFER_FORMAT) {
      throw new Error("File .cepx phải là gói được mã hóa, không chấp nhận JSON rõ.");
    }

    if (parsed?.format === ENCRYPTED_TRANSFER_FORMAT) {
      const passphrase = getPassphrase();
      return decryptTransfer(text, passphrase);
    }

    if (Array.isArray(parsed)) {
      return {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        cookies: parsed,
        windows: []
      };
    }

    if (parsed?.format === TRANSFER_FORMAT && parsed?.version === TRANSFER_VERSION) {
      return parsed;
    }

    if (Array.isArray(parsed?.cookies)) {
      return {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        cookies: parsed.cookies,
        windows: Array.isArray(parsed.windows) ? parsed.windows : []
      };
    }

    throw new Error("Không tìm thấy cookie hợp lệ trong file/gói này.");
  };

  const getDestinationContext = async () => {
    const activeTab = await getOptionalActiveTab();
    if (!activeTab?.id) {
      throw new Error("Không xác định được tab đích. Hãy mở một trang HTTP/HTTPS trong profile đích.");
    }

    const stores = await chrome.cookies.getAllCookieStores();
    const matchingStore = stores.find((store) => store.tabIds?.includes(activeTab.id));
    if (matchingStore) {
      return { activeTab, storeId: matchingStore.id, store: matchingStore };
    }
    if (stores.length === 1) {
      return { activeTab, storeId: stores[0].id, store: stores[0] };
    }

    throw new Error("Không xác định được kho cookie đích. Hãy mở tab web trong đúng profile rồi thử lại.");
  };

  const getActiveHostname = (tab) => {
    try {
      return isSupportedUrl(tab?.url) ? normalizeHost(new URL(tab.url).hostname) : "";
    } catch {
      return "";
    }
  };

  const buildCookieUrls = (cookie, activeTab) => {
    const host = normalizeHost(cookie.domain) || getActiveHostname(activeTab);
    if (!host) return [];

    const requiresHttps = cookie.secure ||
      cookie.name.startsWith("__Secure-") ||
      cookie.name.startsWith("__Host-");
    const schemes = requiresHttps ? ["https"] : ["https", "http"];
    return schemes.map((scheme) => `${scheme}://${host}${normalizePath(cookie.path)}`);
  };

  const setImportedCookie = async (cookie, activeTab, targetStoreId) => {
    const payload = {
      name: cookie.name,
      value: cookie.value,
      path: normalizePath(cookie.path),
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: toChromeSameSite(cookie.sameSite),
      storeId: String(targetStoreId)
    };

    const domain = normalizeHost(cookie.domain);
    if (domain && !cookie.hostOnly) {
      payload.domain = domain;
    }
    if (!cookie.session && typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)) {
      payload.expirationDate = cookie.expirationDate;
    }
    const partitionKey = normalizePartitionKey(cookie.partitionKey);
    if (partitionKey) {
      payload.partitionKey = partitionKey;
    }

    const urls = buildCookieUrls(cookie, activeTab);
    if (!urls.length) {
      throw new Error("Cookie thiếu domain hợp lệ");
    }

    let lastError = "Trình duyệt từ chối cookie";
    for (const url of urls) {
      try {
        const result = await chrome.cookies.set({ ...payload, url });
        if (result) return result;
        lastError = "Trình duyệt trả về kết quả rỗng";
      } catch (error) {
        lastError = error?.message || lastError;
      }
    }
    throw new Error(lastError);
  };

  const addFailureReason = (reasons, error) => {
    const message = String(error?.message || "Lỗi không xác định").slice(0, 180);
    reasons.set(message, (reasons.get(message) || 0) + 1);
  };

  const cookiesEquivalent = (actual, expected) => {
    const actualPartition = normalizePartitionKey(actual.partitionKey);
    const expectedPartition = normalizePartitionKey(expected.partitionKey);
    const expirationMatches = expected.session
      ? !!actual.session
      : !actual.session &&
        Number.isFinite(Number(actual.expirationDate)) &&
        Number.isFinite(Number(expected.expirationDate)) &&
        Math.abs(Number(actual.expirationDate) - Number(expected.expirationDate)) <= 2;
    return String(actual.name ?? "") === String(expected.name ?? "") &&
      String(actual.value ?? "") === String(expected.value ?? "") &&
      normalizeHost(actual.domain) === normalizeHost(expected.domain) &&
      normalizePath(actual.path) === normalizePath(expected.path) &&
      !!actual.hostOnly === !!expected.hostOnly &&
      !!actual.secure === !!expected.secure &&
      !!actual.httpOnly === !!expected.httpOnly &&
      normalizeSameSite(actual.sameSite) === normalizeSameSite(expected.sameSite) &&
      !!actual.session === !!expected.session &&
      expirationMatches &&
      JSON.stringify(actualPartition || null) === JSON.stringify(expectedPartition || null);
  };

  const verifyImportedCookies = async (expectedCookies, targetStoreId) => {
    const result = await getCookiesForFilter({ storeId: targetStoreId });
    const actualByIdentity = new Map(
      result.cookies.map((cookie) => [cookieIdentity(cookie, false), cookie])
    );
    let verified = 0;
    let missing = 0;
    let changed = 0;

    for (const expected of expectedCookies) {
      const actual = actualByIdentity.get(cookieIdentity(expected, false));
      if (!actual) {
        missing++;
      } else if (cookiesEquivalent(actual, expected)) {
        verified++;
      } else {
        changed++;
      }
    }

    return {
      verified,
      missing,
      changed,
      allCookies: result.cookies,
      warnings: result.warnings
    };
  };

  const openSavedTabs = async (windows, targetWindowId) => {
    const tabs = (windows || [])
      .flatMap((browserWindow) => Array.isArray(browserWindow?.tabs) ? browserWindow.tabs : [])
      .filter((tab) => isSupportedUrl(tab?.url));

    let opened = 0;
    let failed = 0;
    for (const [index, tab] of tabs.entries()) {
      try {
        setStatus(`Đang mở lại tab ${index + 1}/${tabs.length}…`, "working");
        const properties = {
          url: tab.url,
          active: false,
          pinned: !!tab.pinned
        };
        if (targetWindowId != null) properties.windowId = targetWindowId;
        await chrome.tabs.create(properties);
        opened++;
      } catch {
        failed++;
      }
    }
    return { opened, failed };
  };

  const importPackage = async () => {
    requireAccessUnlocked();
    const source = await getImportSource();
    setStatus("Đang đọc và kiểm tra gói chuyển…", "working");
    const payload = await parseImportPayload(source.text, source.sourceName);
    const normalized = (Array.isArray(payload.cookies) ? payload.cookies : [])
      .map(normalizeImportCookie)
      .filter(Boolean);
    const sourceStoreIds = new Set(
      normalized
        .map((cookie) => cookie.storeId)
        .filter((storeId) => storeId != null && storeId !== "")
    );
    if (sourceStoreIds.size > 1) {
      throw new Error(
        "Gói chứa nhiều kho cookie/profile nên không thể gộp an toàn. Hãy xuất lại bằng bản mới từ đúng profile nguồn."
      );
    }
    const cookies = dedupeCookies(normalized, false);
    const merged = normalized.length - cookies.length;
    const windows = Array.isArray(payload.windows) ? payload.windows : [];
    const tabTotal = countTabs(windows);
    const shouldOpenTabs = els.openTabsCheckbox.checked && tabTotal > 0;

    if (!cookies.length && !shouldOpenTabs) {
      throw new Error("Gói chuyển không có cookie hoặc tab dùng được.");
    }

    const destination = await getDestinationContext();
    const packageWarnings = payload.scan?.complete === false
      ? (Array.isArray(payload.scan.warnings) ? payload.scan.warnings : ["Gói được tạo từ lần quét chưa đầy đủ."])
      : [];
    const confirmed = confirm(
      `${packageWarnings.length ? `Cảnh báo: gói nguồn có ${packageWarnings.length} lỗi quét.\n\n` : ""}` +
      `Nhập ${cookies.length} cookie vào kho ${destination.storeId}` +
      `${shouldOpenTabs ? ` và mở ${tabTotal} tab` : ""}?\n\n` +
      "Cookie trùng tên/domain/path có thể bị thay thế."
    );
    if (!confirmed) {
      throw new Error("Đã hủy thao tác nhập.");
    }

    let imported = 0;
    let failed = 0;
    const successfulCookies = [];
    const failureReasons = new Map();
    for (const [index, cookie] of cookies.entries()) {
      if (index % 20 === 0 || index === cookies.length - 1) {
        setStatus(`Đang nhập cookie ${index + 1}/${cookies.length}… Giữ popup mở.`, "working");
      }
      try {
        await setImportedCookie(cookie, destination.activeTab, destination.storeId);
        imported++;
        successfulCookies.push(cookie);
      } catch (error) {
        failed++;
        addFailureReason(failureReasons, error);
      }
    }

    let tabResult = { opened: 0, failed: 0 };
    if (shouldOpenTabs) {
      tabResult = await openSavedTabs(windows, destination.activeTab.windowId);
    }

    let verificationWarning = "";
    let verification = { verified: 0, missing: 0, changed: 0, warnings: [] };
    let verificationCompleted = false;
    try {
      verification = await verifyImportedCookies(successfulCookies, destination.storeId);
      verificationCompleted = true;
      state.cookies = verification.allCookies;
      state.stores = [destination.store];
      state.sourceContext = {
        storeId: String(destination.storeId),
        incognito: !!destination.activeTab.incognito
      };
      try {
        state.windows = await captureOpenWindows();
      } catch {
        state.windows = [];
      }
      state.warnings = verification.warnings;
      updateStats();
      if (verification.missing || verification.changed) {
        verificationWarning =
          ` Xác minh: ${verification.verified}/${successfulCookies.length};` +
          ` thiếu ${verification.missing}, bị trình duyệt chuẩn hóa ${verification.changed}.`;
      }
      if (verification.warnings.length) {
        verificationWarning += ` Có ${verification.warnings.length} cảnh báo khi xác minh.`;
      }
    } catch (error) {
      verificationWarning = ` Không xác minh lại được sau khi nhập: ${error?.message || "lỗi trình duyệt"}.`;
    }
    els.passphraseInput.value = "";
    els.importFileInput.value = "";
    els.importTextInput.value = "";

    const mainFailure = [...failureReasons.entries()].sort((a, b) => b[1] - a[1])[0];
    const failureText = mainFailure ? ` Lỗi chính: ${mainFailure[0]} (${mainFailure[1]}).` : "";
    setStatus(
      `Hoàn tất: cookie ${imported}/${cookies.length}, lỗi ${failed}` +
      `${merged ? `, gộp trùng ${merged}` : ""}` +
      `${shouldOpenTabs ? `; tab ${tabResult.opened}/${tabTotal}, lỗi ${tabResult.failed}` : ""}.` +
      `${verificationCompleted && successfulCookies.length && !verification.missing && !verification.changed
        ? ` Đã xác minh ${verification.verified}/${successfulCookies.length}.`
        : ""}` +
      failureText + verificationWarning,
      failed || tabResult.failed || verificationWarning ? "warning" : "success"
    );
  };

  const clearImport = () => {
    els.importFileInput.value = "";
    els.importTextInput.value = "";
    setStatus("Đã xóa file/nội dung nhập.", "idle");
  };

  const runAction = async (action) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setStatus(error?.message || "Thao tác thất bại.", "error");
    } finally {
      setBusy(false);
    }
  };

  const bindEvents = () => {
    els.scanBtn.addEventListener("click", () => runAction(scanProfile));
    els.exportFileBtn.addEventListener("click", () => runAction(exportEncryptedFile));
    els.copyPackageBtn.addEventListener("click", () => runAction(copyEncryptedPackage));
    els.importBtn.addEventListener("click", () => runAction(importPackage));
    els.clearImportBtn.addEventListener("click", clearImport);
  };

  const bindAccessEvents = () => {
    els.accessForm.addEventListener("submit", (event) => {
      event.preventDefault();
      return runAccessAction(handleAccessSubmit);
    });
  };

  const init = async () => {
    const manifest = chrome.runtime.getManifest();
    els.versionBadge.textContent = `v${manifest.version}`;
    els.accessVersionBadge.textContent = `v${manifest.version}`;
    bindEvents();
    bindAccessEvents();
    await initializeAccessGate();
  };

  document.addEventListener("DOMContentLoaded", () => init());
})();
