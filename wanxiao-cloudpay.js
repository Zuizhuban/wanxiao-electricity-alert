#!/usr/bin/env node
/**
 * 完美校园「云缴费 → 预付费 → 用电支出」电费查询客户端
 *
 * 适用场景：你学校的电费在完美校园里是「首页 → 缴费 → 预付费 → 用电支出 → 选房间」看的，
 *           而不是「智能水电」里看的。原理与参数说明见 outputs/yunjiaofei-route.md
 *
 * 用法（先做自检，不需要账号）：
 *   node wanxiao-cloudpay.js --selftest
 *
 * 列出你的公寓和房间（需要账号密码）：
 *   node wanxiao-cloudpay.js --phone 13800000000 --password '你的密码' --list
 *
 * 查某个房间的剩余电量：
 *   node wanxiao-cloudpay.js --phone 13800000000 --password '你的密码' --room <房间ID>
 *
 * 也可以全部走环境变量（推荐，别把密码写在命令行历史里）：
 *   WANXIAO_PHONE=138... WANXIAO_PASSWORD=... node wanxiao-cloudpay.js --list
 *
 * 需要 Node.js 18 以上（自带 fetch），不需要任何第三方依赖。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ==================== 常量 ====================
const EXCHANGE_URL = "https://app.17wanxiao.com/campus/cam_iface46/exchangeSecretkey.action";
const LOGIN_URL = "https://app.17wanxiao.com/campus/cam_iface46/loginnew.action";
const CLOUD_BASE = "https://h5cloud.17wanxiao.com:18443";
const PAY_DO = CLOUD_BASE + "/CloudPayment/user/pay.do";
const GET_ROOM = CLOUD_BASE + "/CloudPayment/user/getRoom.do";
const GET_ROOM_STATE = CLOUD_BASE + "/CloudPayment/user/getRoomState.do";
const DES_IV = "66666666";
const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 12; EBG-AN00 Build/HUAWEIEBG-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 Mobile Safari/537.36 Wanxiao/5.8.3";
const SEND_SMS_URL = "https://app.17wanxiao.com/campus/cam_iface46/gainMatrixCaptcha.action";
const SMS_LOGIN_URL =
  "https://app.17wanxiao.com/campus/cam_iface46/registerUsersByTelAndLoginNew.action";

// ==================== 命令行参数 ====================
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.replace(/^--/, "");
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
}

const cfg = {
  phone: String(flags.phone || process.env.WANXIAO_PHONE || "").trim(),
  password: String(flags.password || process.env.WANXIAO_PASSWORD || ""),
  deviceId: String(flags["device-id"] || process.env.WANXIAO_DEVICE_ID || "").trim(),
  schoolCode: String(flags.schoolcode || process.env.WANXIAO_SCHOOLCODE || "").trim(),
  payProId: String(flags["pay-pro-id"] || process.env.WANXIAO_PAY_PRO_ID || "").trim(),
  room: String(flags.room || process.env.WANXIAO_ROOM || "").trim(),
  appVersion: String(flags["app-version"] || process.env.WANXIAO_APP_VERSION || "10583101"),
  deviceModel: String(flags["device-model"] || "EBG-AN00"),
  deviceCode: String(flags["device-code"] || "raphael"),
  passwordMode: String(flags["password-mode"] || "array"), // array | string
  smsLogin: flags["sms-login"] === true,
  sendSmsOnly: flags["send-sms-only"] === true,
  deviceFile: String(flags["device-file"] || "wanxiao-device.json"),
  cookie: String(flags.cookie || process.env.WANXIAO_COOKIE || "").trim(),
  threshold: String(flags.threshold || process.env.WANXIAO_THRESHOLD || "").trim(),
  qmsgKey: String(flags["qmsg-key"] || process.env.WANXIAO_QMSG_KEY || "").trim(),
  alertQq: String(flags["alert-qq"] || process.env.WANXIAO_ALERT_QQ || "").trim(),
  // low-only：只有低于阈值才推（默认）；always：不管多少度都推，用来"手动查当前电量"
  pushMode: String(flags["push-mode"] || process.env.WANXIAO_PUSH_MODE || "low-only").trim(),
  debugDir: String(flags["debug-dir"] || "wanxiao-debug"),
  debug: true, // 始终落盘调试数据，方便排错
  selftest: flags.selftest === true,
  list: flags.list === true,
  all: flags.all === true,
  verbose: flags.verbose !== false,
};

// ==================== 小工具 ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const step = (name) => log("\n── " + name + " " + "─".repeat(Math.max(0, 46 - name.length)));

function ensureDebugDir() {
  try {
    fs.mkdirSync(cfg.debugDir, { recursive: true });
  } catch {}
}

function saveDebug(name, content) {
  if (!cfg.debug) return;
  try {
    const p = path.join(cfg.debugDir, name);
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  } catch (e) {
    log("  [warn] 写调试文件失败: " + e.message);
  }
}

/** 3DES-CBC / PKCS7，密钥 24 字节，IV 固定 66666666（和参考实现一致） */
function des3Encrypt(plain, appKey) {
  const key = Buffer.from(String(appKey).slice(0, 24), "utf8");
  if (key.length !== 24) throw new Error("3DES 密钥必须 24 字节，当前 " + key.length);
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, Buffer.from(DES_IV, "utf8"));
  return Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]).toString("base64");
}

function randomImei() {
  let s = "86";
  for (let i = 0; i < 13; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** 读终端输入（用于让用户手输短信验证码） */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(String(ans).trim());
    });
  });
}

/** 设备 ID 需要"被验证过"才能免验证码登录，这里把验证过的 ID 存本地复用 */
function loadDeviceId() {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.deviceFile, "utf8"));
    if (j.deviceId) return { deviceId: String(j.deviceId), phone: j.phone ? String(j.phone) : "" };
  } catch {}
  return null;
}

function saveDeviceId(deviceId, phone) {
  try {
    fs.writeFileSync(
      cfg.deviceFile,
      JSON.stringify({ deviceId, phone, savedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    log("  ✓ 已把验证过的设备 ID 存到 " + path.resolve(cfg.deviceFile) + "（以后不用再收验证码）");
  } catch (e) {
    log("  [warn] 设备 ID 保存失败：" + e.message);
  }
}

/** 统一的加密上行（换密钥之后所有接口都是这个套路） */
async function encryptedPost(url, secret, payload, debugName) {
  const data = des3Encrypt(JSON.stringify(payload), secret.appKey);
  const bodyText = '{"session": ' + JSON.stringify(secret.session) + ', "data": ' + JSON.stringify(data) + "}";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": DEFAULT_UA,
      "Content-Type": "application/json",
      campusSign: sha256Hex(bodyText),
    },
    body: bodyText,
  });
  const text = await res.text();
  if (debugName) saveDebug(debugName, text);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("接口返回不是 JSON（HTTP " + res.status + "）：" + text.slice(0, 300));
  }
  return j;
}

// ==================== 第 1 步：交换密钥 ====================
async function exchangeSecret() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "der" },
  });
  const priv = crypto.createPrivateKey({ key: privateKey, format: "der", type: "pkcs1" });

  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "User-Agent": DEFAULT_UA, "Content-Type": "application/json" },
    body: JSON.stringify({ key: publicKey.toString("base64") }),
  });
  const text = await res.text();
  saveDebug("01-exchange.raw.txt", text);
  if (!res.ok) throw new Error("交换密钥 HTTP " + res.status + "：" + text.slice(0, 200));

  let info;
  try {
    const dec = crypto.privateDecrypt(
      { key: priv, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(text, "base64")
    );
    info = JSON.parse(dec.toString("utf8"));
  } catch (e) {
    throw new Error("交换密钥返回内容无法解密（接口可能变了）：" + e.message);
  }
  if (!info.session || !info.key) throw new Error("交换密钥返回缺少 session/key：" + JSON.stringify(info));
  saveDebug("01-exchange.json", info);
  return { session: info.session, appKey: String(info.key).slice(0, 24) };
}

// ==================== 第 2 步：登录 ====================
async function login(secret, deviceId) {
  const encPwd = [...cfg.password].map((ch) => des3Encrypt(ch, secret.appKey));
  const loginArgs = {
    appCode: "M002",
    deviceId: deviceId,
    netWork: "wifi",
    password: cfg.passwordMode === "string" ? encPwd.join("") : encPwd,
    qudao: "guanwang",
    requestMethod: "cam_iface46/loginnew.action",
    shebeixinghao: cfg.deviceCode,
    systemType: "android",
    telephoneInfo: "12",
    telephoneModel: cfg.deviceModel,
    type: "1",
    userName: cfg.phone,
    wanxiaoVersion: Number(cfg.appVersion) || cfg.appVersion,
  };
  const j = await encryptedPost(LOGIN_URL, secret, loginArgs, "02-login-response.txt");
  if (!j.result_) {
    const msg = j.message_ || JSON.stringify(j);
    if (String(j.code_) === "5" && /新设备|验证|验证码/.test(msg)) {
      const e = new Error(msg);
      e.needSms = true;
      throw e;
    }
    throw new Error("登录失败：" + msg);
  }
  return { token: secret.session, deviceId };
}

/** 发送短信验证码（新设备验证用） */
async function sendSms(secret, deviceId) {
  const payload = {
    action: "registAndLogin",
    deviceId: deviceId,
    mobile: cfg.phone,
    requestMethod: "cam_iface46/gainMatrixCaptcha.action",
    type: "sms",
  };
  const j = await encryptedPost(SEND_SMS_URL, secret, payload, "02-sms-send-response.txt");
  if (!j.result_) throw new Error("短信发送失败：" + (j.message_ || JSON.stringify(j)));
  return j.message_ || "验证码已发送";
}

/** 用短信验证码登录（同时把当前设备登记为已验证设备） */
async function smsLogin(secret, deviceId, sms) {
  const payload = {
    appCode: "M002",
    deviceId: deviceId,
    netWork: "wifi",
    qudao: "guanwang",
    requestMethod: "cam_iface46/registerUsersByTelAndLoginNew.action",
    shebeixinghao: cfg.deviceCode,
    sms: sms,
    systemType: "android",
    telephoneInfo: "12",
    telephoneModel: cfg.deviceModel,
    mobile: cfg.phone,
    type: "2",
    wanxiaoVersion: Number(cfg.appVersion) || cfg.appVersion,
  };
  const j = await encryptedPost(SMS_LOGIN_URL, secret, payload, "02-sms-login-response.txt");
  if (!j.result_) throw new Error("短信登录失败：" + (j.message_ || JSON.stringify(j)));
  return { token: secret.session, deviceId };
}

// ==================== 第 3 步：换取云缴费 SESSION ====================
async function getCloudCookie(token) {
  const params = new URLSearchParams({
    customerId: String(1000 + Math.floor(Math.random() * 999)),
    systemType: "android",
    UAinfo: "wanxiao",
    versioncode: cfg.appVersion,
    token: token,
  });
  const res = await fetch(PAY_DO + "?" + params.toString(), {
    redirect: "manual",
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "X-Requested-With": "com.newcapec.mobile.ncp",
    },
  });

  const setCookie = res.headers.get("set-cookie") || "";
  const m = /SESSION=[^;]+/.exec(setCookie);
  saveDebug("03-paydo-headers.txt", "status=" + res.status + "\nset-cookie=" + setCookie);
  if (!m) {
    const body = await res.text();
    saveDebug("03-paydo-body.html", body);
    throw new Error("没能拿到 SESSION cookie（HTTP " + res.status + "），可能是 token 无效或接口变了");
  }
  const cookie = m[0];
  const location = res.headers.get("location");

  // 跟着跳转进云缴费页面（顺便把首页 HTML 存下来，用于自动发现 payProId/schoolcode）
  const landing = location
    ? new URL(location, PAY_DO).toString()
    : PAY_DO + "?" + params.toString();
  const page = await fetch(landing, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Cookie: cookie,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "X-Requested-With": "com.newcapec.mobile.ncp",
    },
  });
  const html = await page.text();
  saveDebug("03-landing.html", html);
  return { cookie, html };
}

/** 取出页面里的隐藏 input：hostCustomerCode=云缴费学校编码，payUserIdNum=学号/账号 */
function extractHidden(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const id = (/\bid="([^"]+)"/.exec(tag) || [])[1];
    const name = (/\bname="([^"]+)"/.exec(tag) || [])[1];
    const value = (/\bvalue="([^"]*)"/.exec(tag) || [])[1] || "";
    if (id && !(id in out)) out[id] = value;
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

/** 拉取「可用缴费项目列表」，返回 payprolist */
async function querySelfPayList(cookie) {
  const j = await cloudGet(CLOUD_BASE + "/CloudPayment/bill/querySelfPayList.do", cookie, "", "04-selfpay-list.json");
  return j.payprolist || [];
}

/** 打开「用电支出」页面，顺便取出历史缴费房间（你自己绑过的房间就在这里，省得逐级下钻） */
async function openElecPage(cookie, payProId) {
  const html = await cloudGetText(CLOUD_BASE + "/CloudPayment/bill/selectPayProject.do", cookie, payProId, "04-elec-page.html", {
    txcode: "elecdetails",
    interurl: "elecdetails",
    payProId: payProId,
    amtflag: "0",
    payamt: "0",
    payproname: "用电支出",
    img: "https://payicons.59wanmei.com/cloudpayment/images/project/img-nav_2.png",
    subPayProId: "",
  });
  const rooms = [...html.matchAll(/onclick="clickHistoryRoom\(this\)"[^>]*name="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({
    verify: m[1],
    name: m[2].trim(),
  }));
  return { html, rooms, hidden: extractHidden(html) };
}

// ==================== 第 4 步：查询 ====================
function refererFor(payProId) {
  if (!payProId) return CLOUD_BASE + "/CloudPayment/user/pay.do";
  return (
    CLOUD_BASE +
    "/CloudPayment/bill/selectPayProject.do?txcode=elecdetails&interurl=elecdetails&payProId=" +
    payProId +
    "&amtflag=0&payamt=100&payproname=" +
    encodeURIComponent("用电支出") +
    "&img=https://payicons.59wanmei.com/cloudpayment/images/project/img-nav_2.png&subPayProId="
  );
}

async function cloudRaw(url, cookie, referer, debugName, accept) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: accept || "application/json, text/javascript, */*; q=0.01",
      Cookie: cookie,
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const text = await res.text();
  if (debugName) saveDebug(debugName, text);
  return { status: res.status, text };
}

async function cloudGet(url, cookie, payProId, debugName) {
  const { status, text } = await cloudRaw(url, cookie, refererFor(payProId), debugName);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("返回不是 JSON（HTTP " + status + "）：" + text.slice(0, 300));
  }
  return json;
}

/** 带查询参数、要 HTML 而不是 JSON 的请求 */
async function cloudGetText(base, cookie, payProId, debugName, params) {
  const url = base + "?" + new URLSearchParams(params).toString();
  const { text } = await cloudRaw(
    url,
    cookie,
    refererFor(payProId),
    debugName,
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  );
  return text;
}

/**
 * 房间查询：optype 1=校区 2=楼栋 3=楼层 4=房间
 * businesstype：1=水费 2=电费（见 createSelfOrder.js 注释）
 */
async function roomQuery(cookie, payProId, schoolCode, opts, debugName) {
  const q = new URLSearchParams({
    payProId,
    schoolcode: schoolCode,
    optype: String(opts.optype),
    areaid: String(opts.areaid ?? "0"),
    buildid: String(opts.buildid ?? "0"),
    unitid: "0",
    levelid: String(opts.levelid ?? "0"),
    businesstype: "2",
  });
  return cloudGet(GET_ROOM + "?" + q.toString(), cookie, payProId, debugName);
}

/** 查某房间的剩余电量：返回 { returncode:"100", quantity:"169.82", quantityunit:"度", ... } */
async function roomState(cookie, payProId, schoolCode, roomVerify, debugName) {
  const q = new URLSearchParams({
    payProId,
    schoolcode: schoolCode,
    businesstype: "2",
    roomverify: String(roomVerify),
  });
  return cloudGet(GET_ROOM_STATE + "?" + q.toString(), cookie, payProId, debugName);
}

/** 逐级下钻列出所有房间（历史房间用不了时的兜底方案） */
async function listAllRooms(cookie, payProId, schoolCode, limit) {
  const rooms = [];
  const areas = (await roomQuery(cookie, payProId, schoolCode, { optype: 1 }, "04-areas.json")).roomlist || [];
  for (const a of areas) {
    await sleep(600);
    const builds =
      (await roomQuery(cookie, payProId, schoolCode, { optype: 2, areaid: a.id }, "04-builds-" + a.id + ".json"))
        .roomlist || [];
    for (const b of builds) {
      if (rooms.length >= limit) return rooms;
      await sleep(600);
      const levels =
        (
          await roomQuery(
            cookie,
            payProId,
            schoolCode,
            { optype: 3, areaid: a.id, buildid: b.id },
            "04-levels-" + b.id + ".json"
          )
        ).roomlist || [];
      for (const l of levels) {
        if (rooms.length >= limit) return rooms;
        await sleep(600);
        const rl =
          (
            await roomQuery(
              cookie,
              payProId,
              schoolCode,
              { optype: 4, areaid: a.id, buildid: b.id, levelid: l.id },
              "04-rooms-" + b.id + "-" + l.id + ".json"
            )
          ).roomlist || [];
        for (const r of rl) {
          rooms.push({ area: a.name, build: b.name, level: l.name, verify: r.id, name: r.name });
        }
      }
    }
  }
  return rooms;
}

/** 解析剩余电量（这个接口很规矩：quantity + quantityunit） */
function readQuantity(state) {
  if (!state || typeof state !== "object") return null;
  const q = state.quantity;
  if (q === undefined || q === null || q === "" || q === "-1") return null;
  return { value: String(q), unit: state.quantityunit || "度", desc: state.description || "", extra: state.custparams || "" };
}

/** Qmsg 酱推送（和原项目用的是同一个服务） */
async function pushQmsg(key, qq, msg) {
  const res = await fetch("https://qmsg.zendee.cn/send/" + key, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "qq=" + encodeURIComponent(qq) + "&msg=" + encodeURIComponent(msg),
  });
  const text = await res.text();
  let ok = false;
  try {
    ok = JSON.parse(text).success === true;
  } catch {}
  return { ok, text: text.slice(0, 200) };
}

// ==================== 主流程 ====================
async function main() {
  ensureDebugDir();
  log("完美校园 云缴费（用电支出）查询客户端");
  log("调试数据目录：" + path.resolve(cfg.debugDir));

  // ---- 自检 ----
  if (cfg.selftest) {
    step("自检：只做 RSA 交换密钥（不需要账号）");
    const r = await exchangeSecret();
    log("  ✓ 交换密钥成功");
    log("    session = " + r.session.slice(0, 12) + "...");
    log("    appKey  = " + r.appKey.slice(0, 8) + "...（24 位 3DES 密钥）");
    log("\n自检通过：网络、加密、接口都正常。接下来把账号密码准备好，去掉 --selftest 再跑。");
    return;
  }

  const B = path.basename(process.argv[1] || "wanxiao-cloudpay.js");

  // ---- 参数检查 ----
  const needPhone = !cfg.cookie;
  const needPassword = !cfg.cookie && !cfg.smsLogin && !cfg.sendSmsOnly;
  if ((needPhone && !cfg.phone) || (needPassword && !cfg.password)) {
    log("\n缺少账号信息。两种写法都行：");
    log("  1) 命令行：node " + B + " --phone 13800000000 --password '你的密码' --list");
    log("  2) 环境变量：WANXIAO_PHONE=138... WANXIAO_PASSWORD=... node " + B + " --list");
    log("\n提示：完美校园的登录账号是**手机号**（不是学号）。");
    log("如果是新设备要验证码：加 --sms-login（不需要密码，但需要手机收验证码）。");
    process.exit(2);
  }

  // ---- 设备 ID ----
  const saved = loadDeviceId();
  let deviceId = cfg.deviceId;
  if (!deviceId && saved && (!saved.phone || saved.phone === cfg.phone)) {
    deviceId = saved.deviceId;
    log("[info] 使用本地缓存的设备 ID：" + deviceId);
  }
  if (!deviceId) {
    deviceId = randomImei();
    log("[info] 本次使用随机生成的设备 ID：" + deviceId);
  }
  if (cfg.deviceId) log("[info] 使用指定的设备 ID：" + deviceId);

  let cookie;
  let landingHidden = {};

  if (cfg.cookie) {
    // 复用已有 SESSION（调试用，就不用每次重新登录）
    step("0/4 复用已有 SESSION cookie（跳过登录）");
    cookie = cfg.cookie;
    log("  ✓ " + cookie.slice(0, 32) + "...");
  } else {
    step("1/4 交换密钥");
    const secret = await exchangeSecret();
    log("  ✓ 拿到 session 和 3DES 密钥");

    // ---- 只发短信 ----
    if (cfg.sendSmsOnly) {
      step("发送短信验证码");
      log("  ✓ " + (await sendSms(secret, deviceId)));
      log("\n验证码已发送到 " + cfg.phone + "，请尽快执行（同一个脚本、同一台机器）：");
      log("  node " + B + " --phone " + cfg.phone + " --sms-login");
      return;
    }

    step("2/4 登录完美校园");
    let token;
    if (cfg.smsLogin) {
      log("  " + (await sendSms(secret, deviceId)));
      const code = await ask("  请输入手机收到的短信验证码: ");
      if (!code) throw new Error("没有输入验证码，已取消");
      token = (await smsLogin(secret, deviceId, code)).token;
      log("  ✓ 短信登录成功");
      saveDeviceId(deviceId, cfg.phone);
    } else {
      try {
        token = (await login(secret, deviceId)).token;
      } catch (e) {
        if (e.needSms) {
          log("");
          log("⚠️  服务端要求短信验证（新设备风控）：" + e.message);
          log("    这是完美校园对「新设备」的保护，不是密码错。按下面两步走：");
          log("      1) node " + B + " --phone " + cfg.phone + " --send-sms-only");
          log("      2) node " + B + " --phone " + cfg.phone + " --sms-login");
          log("    验证通过后，设备 ID 会被记到 " + cfg.deviceFile + "，之后就能用密码登录了。");
          process.exit(4);
        }
        throw e;
      }
    }
    log("  ✓ 登录成功（deviceId=" + deviceId + "）");

    step("3/4 换取云缴费 SESSION");
    const got = await getCloudCookie(token);
    cookie = got.cookie;
    landingHidden = extractHidden(got.html);
    log("  ✓ 拿到 SESSION：" + cookie.slice(0, 30) + "...");
  }

  // ---- 缴费项目 id（用电支出）----
  let payProId = cfg.payProId;
  const projects = await querySelfPayList(cookie);
  if (projects.length) {
    log("  可用缴费项目：" + projects.map((p) => p.payproname + "(id=" + p.id + ")").join("、"));
  }
  if (!payProId) {
    const elec =
      projects.find((p) => /用电|电费/.test(p.payproname || "")) ||
      projects.find((p) => p.txcode === "elecdetails");
    if (elec) payProId = String(elec.id);
  }
  if (!payProId) {
    log("\n没能自动找到「用电支出」项目，请用 --pay-pro-id 手动传入。");
    process.exit(3);
  }
  log("  使用 payProId=" + payProId);

  step("4/4 查询房间与剩余电量");

  // 历史缴费房间 = 你绑过的房间，通常就是你需要盯的那一间
  const page = await openElecPage(cookie, payProId);

  // ---- 学校编码（云缴费的 hostCustomerCode）----
  const schoolCode = cfg.schoolCode || landingHidden.hostCustomerCode || page.hidden.hostCustomerCode || "";
  if (page.hidden.payUserIdNum) log("  缴费账号（学号）：" + page.hidden.payUserIdNum);
  if (!schoolCode) {
    log("\n没能自动读到学校编码（hostCustomerCode）。请用 --schoolcode 手动传入。");
    log("调试文件已存到 " + path.resolve(cfg.debugDir));
    process.exit(3);
  }
  log("  学校编码 schoolcode=" + schoolCode);

  let targets = page.rooms.map((r) => ({ verify: r.verify, name: r.name }));

  if (targets.length) {
    log("  历史缴费房间：");
    targets.forEach((t) => log("    - " + t.name + "  (roomverify=" + t.verify + ")"));
  }

  if (cfg.room) {
    targets = [{ verify: cfg.room, name: "指定房间" }];
  } else if (cfg.all) {
    log("  正在逐级列出所有房间（校区 → 楼栋 → 楼层 → 房间）……");
    targets = await listAllRooms(cookie, payProId, schoolCode, 400);
    log("  共 " + targets.length + " 个房间");
  } else if (!targets.length) {
    log("  没有历史房间记录，先列出前 60 个房间（要全查加 --all，要指定加 --room <roomverify>）：");
    const all = await listAllRooms(cookie, payProId, schoolCode, 60);
    all.forEach((r) => log("    - " + r.area + " / " + r.build + " / " + r.level + " / " + r.name + "  (roomverify=" + r.verify + ")"));
    log("\n完成。调试数据都在 " + path.resolve(cfg.debugDir) + "。");
    return;
  }

  // ---- 读电量 ----
  log("");
  let belowThreshold = false;
  const report = [];
  for (const t of targets) {
    if (targets.length > 1) await sleep(1200);
    const safe = String(t.verify).replace(/[^\w-]/g, "_");
    try {
      const st = await roomState(cookie, payProId, schoolCode, t.verify, "05-state-" + safe + ".json");
      const info = readQuantity(st);
      if (info) {
        log("  " + t.name + " → 剩余 " + info.value + " " + info.unit);
        report.push(t.name + " 剩余 " + info.value + " " + info.unit);
        if (cfg.threshold && Number(info.value) < Number(cfg.threshold)) belowThreshold = true;
      } else {
        log("  " + t.name + " → 没读到电量，原始返回：" + JSON.stringify(st).slice(0, 200));
      }
    } catch (e) {
      log("  " + t.name + " 查询失败：" + e.message);
    }
  }

  log("\nALERT=" + (belowThreshold ? 1 : 0)); // 给 CI/脚本用的机器可读标记

  if (cfg.threshold) {
    log(
      belowThreshold
        ? "\n⚠️  有房间低于阈值 " + cfg.threshold + " 度"
        : "\n✓ 电量都在阈值 " + cfg.threshold + " 度以上"
    );
  }

  // 推送：默认只在低于阈值时推；--push-mode always 时不管多少度都推（手动"查当前电量"用）
  const wantPush = cfg.qmsgKey && cfg.alertQq && (belowThreshold || cfg.pushMode === "always");
  if (wantPush) {
    const msg = belowThreshold
      ? "[电费不足提醒] 剩余电量低于 " + (cfg.threshold || "设定阈值") + " 度，请及时充值～ " + report.join("；")
      : "[电量查询] 当前剩余电量：" + report.join("；");
    log("\n正在推送：\n  " + msg);
    const r = await pushQmsg(cfg.qmsgKey, cfg.alertQq, msg);
    log(r.ok ? "  ✓ 已通过 Qmsg 酱推送到 QQ " + cfg.alertQq : "  ✗ Qmsg 推送失败：" + r.text);
  } else if (cfg.pushMode === "always" && (!cfg.qmsgKey || !cfg.alertQq)) {
    log("\n[提示] 指定了 --push-mode always，但没配 Qmsg KEY / QQ 号，跳过推送。");
  }

  if (cfg.threshold) process.exit(belowThreshold ? 10 : 0);
  log("\n完成。调试数据都在 " + path.resolve(cfg.debugDir) + "。");
}

main().catch((e) => {
  log("\n❌ 出错了：" + e.message);
  log("调试数据已保存到 " + path.resolve(cfg.debugDir));
  log("把报错原文（不要带密码）发我即可。");
  process.exit(1);
});
