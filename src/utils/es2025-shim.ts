/**
 * pdfjs-dist 6.x 需要的 ES2025 新 API 垫片。
 *
 * 为什么需要：pdf.js 6 直接用了几个只有很新的 Chromium 才实现的 API，
 * 而 ThShell 跑在 Electron 33（Chromium 130）上。表现是"同一个 PDF 浏览器能打开、
 * 我们打不开"，而且报错还分好几层：
 *   1. `Uint8Array.prototype.toHex / toBase64`、`Uint8Array.fromBase64`
 *      —— Chromium 133+。缺了会在**加载阶段**就抛 `a.toHex is not a function`。
 *   2. `Map.prototype.getOrInsertComputed` —— 更晚（Chromium 141 左右）。
 *      缺了加载能过、**渲染第一页时才炸**：`getOrInsertComputed is not a function`，
 *      界面上没有报错提示（pdf.js 把它当成单页渲染失败吞掉了），只是一片空白。
 *   3. `Math.sumPrecise`、`Promise.try` —— 同一批新东西，顺手一起垫。
 *
 * 为什么要写成字符串：pdf.js 的解析在主线程和 worker 两边跑。worker 是从 Blob 里起的
 * （见 PdfPreview.vue：file:// 下只能这么起 worker），它 import 不到我们的模块，
 * 只能把同一段源码前置到 worker 源码前面。一份源码两处用，免得手写两份慢慢长歪。
 *
 * 每个 API 都先判断原生有没有：已经是新 Chromium 时全部跳过，
 * **Electron 升到 35+ 之后这个文件可以直接删**，不用改任何调用点。
 */

export const ES2025_SHIM = String.raw`(function () {
  function def(target, name, fn) {
    if (!target || typeof target[name] === 'function') return;
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true });
  }
  // 一次 fromCharCode 最多几千个参数，8192 是安全值
  function toBinary(arr) {
    var out = '';
    for (var i = 0; i < arr.length; i += 8192) {
      out += String.fromCharCode.apply(null, arr.subarray(i, i + 8192));
    }
    return out;
  }

  /* ---------- Uint8Array 的 hex / base64 ---------- */
  def(Uint8Array.prototype, 'toHex', function () {
    var out = '';
    for (var i = 0; i < this.length; i++) {
      out += (this[i] < 16 ? '0' : '') + this[i].toString(16);
    }
    return out;
  });
  def(Uint8Array.prototype, 'toBase64', function (options) {
    var text = btoa(toBinary(this));
    if (options && options.alphabet === 'base64url') {
      text = text.replace(/\+/g, '-').replace(/\//g, '_');
    }
    if (options && options.omitPadding) text = text.replace(/=+$/, '');
    return text;
  });
  function fromBase64(input, options) {
    var text = String(input);
    if (options && options.alphabet === 'base64url') {
      text = text.replace(/-/g, '+').replace(/_/g, '/');
    }
    text = text.replace(/=+$/, '');
    var binary = atob(text);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  def(Uint8Array, 'fromBase64', fromBase64);
  def(Uint8Array, 'fromHex', function (input) {
    var text = String(input);
    var out = new Uint8Array(text.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
  });

  /* ---------- Map / WeakMap 的 upsert ---------- */
  // getOrInsertComputed 的回调按规范会收到 key；pdf.js 的调用点全是无参箭头函数，两种都兼容
  def(Map.prototype, 'getOrInsert', function (key, value) {
    if (this.has(key)) return this.get(key);
    this.set(key, value);
    return value;
  });
  def(Map.prototype, 'getOrInsertComputed', function (key, fn) {
    if (this.has(key)) return this.get(key);
    var value = fn(key);
    this.set(key, value);
    return value;
  });
  def(WeakMap.prototype, 'getOrInsert', Map.prototype.getOrInsert);
  def(WeakMap.prototype, 'getOrInsertComputed', Map.prototype.getOrInsertComputed);

  /* ---------- Math.sumPrecise ---------- */
  // 规范是"精确求和后一次舍入"。这里用 Neumaier 补偿求和，对 pdf.js 的用途
  // （数一数字符总长度）精度完全够，没必要真去实现 BigInt 版本
  def(Math, 'sumPrecise', function (items) {
    var sum = 0, c = 0;
    for (var it = items[Symbol.iterator](), step = it.next(); !step.done; step = it.next()) {
      var x = +step.value;
      if (!isFinite(x)) return NaN;
      var t = sum + x;
      c += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
      sum = t;
    }
    return sum + c;
  });

  /* ---------- Promise.try ---------- */
  def(Promise, 'try', function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) {
      resolve(fn.apply(undefined, args));
    });
  });
})();`

/**
 * 主线程装一次。每个 API 内部各自判断原生有没有，装两次也无害。
 * 用 `new Function` 而不是直接写函数体，是为了让 shim 只有一份源码 ——
 * 这份字符串还要原样拼到 worker 前面。CSP 里已放开 `unsafe-eval`。
 */
export function installEs2025Shim(): void {
  new Function(ES2025_SHIM)()
}
