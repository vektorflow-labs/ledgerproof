/* LedgerProof free CSV converter: bank CSV -> OFX / QIF / QuickBooks Online CSV / Xero CSV.
   Runs entirely in the browser. Nothing is uploaded. */
(function () {
  "use strict";

  // ---------- core (pure functions, also used by tests under Node) ----------
  function detectDelimiter(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 5);
    var best = ",", bestScore = -1;
    [",", ";", "\t", "|"].forEach(function (d) {
      var counts = lines.map(function (l) { return splitLine(l, d).length; });
      var min = Math.min.apply(null, counts);
      var same = counts.every(function (c) { return c === counts[0]; });
      var score = (min > 1 ? min : 0) + (same ? 100 : 0) * (min > 1 ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function splitLine(line, d) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === d) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseCSV(text, d) {
    text = text.replace(/^﻿/, "");
    // join quoted fields that contain line breaks
    var rows = [], buf = "", quotes = 0;
    text.split(/\r?\n/).forEach(function (l) {
      buf = buf ? buf + "\n" + l : l;
      quotes += (l.match(/"/g) || []).length;   // count each line once: linear time
      if (quotes % 2 === 0) { if (buf.trim()) rows.push(splitLine(buf, d)); buf = ""; quotes = 0; }
    });
    if (buf.trim()) rows.push(splitLine(buf, d));
    return rows;
  }

  function parseNumber(s, fmt) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/DR\s*$/i.test(s)) { neg = true; s = s.replace(/DR\s*$/i, ""); }
    s = s.replace(/CR\s*$/i, "");
    if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ""); }
    s = s.replace(/[^\d.,\-+]/g, "");
    if (s.charAt(0) === "-") { neg = !neg; s = s.slice(1); }
    if (s.charAt(0) === "+") s = s.slice(1);
    if (!s || !/\d/.test(s)) return null;
    var f = fmt;
    if (f === "auto") {
      var lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
      if (lc > -1 && ld > -1) f = lc > ld ? "eu" : "us";
      else if (lc > -1) f = (s.length - lc - 1 === 3 && s.split(",").length > 1 && !/,\d{1,2}$/.test(s)) ? "us" : "eu";
      else if (ld > -1) f = (s.split(".").length > 2) ? "eu" : "us";
      else f = "us";
    }
    if (f === "eu") s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    var v = parseFloat(s);
    if (isNaN(v)) return null;
    return Math.round((neg ? -v : v) * 100) / 100;
  }

  var MONTHS = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12 };

  function dateParts(s) {
    s = String(s || "").trim();
    var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return { iso: true, a: +m[1], b: +m[2], c: +m[3] };
    m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3})[A-Za-z]*[-\/. ,]+(\d{2,4})/);
    if (m && MONTHS[m[2].toLowerCase()]) return { named: true, d: +m[1], mo: MONTHS[m[2].toLowerCase()], y: +m[3] };
    m = s.match(/^([A-Za-z]{3})[A-Za-z]*[-\/. ](\d{1,2})[-\/. ,]+(\d{2,4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return { named: true, d: +m[2], mo: MONTHS[m[1].toLowerCase()], y: +m[3] };
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) return { a: +m[1], b: +m[2], c: +m[3] };
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return { iso: true, a: +m[1], b: +m[2], c: +m[3] };
    return null;
  }

  function guessDateFormat(values) {
    var dmy = 0, mdy = 0;
    values.forEach(function (v) {
      var p = dateParts(v);
      if (!p || p.iso || p.named) return;
      if (p.a > 12) dmy++;
      if (p.b > 12) mdy++;
    });
    if (mdy !== dmy) return mdy > dmy ? "mdy" : "dmy";
    // ambiguous (every part <= 12): a statement covers a short period, so keep the reading with the smaller date span
    function span(fmt) {
      var t = values.map(function (v) { var d = parseDate(v, fmt); return d ? Date.UTC(d.y, d.m - 1, d.d) : null; })
        .filter(function (x) { return x !== null; });
      return t.length ? Math.max.apply(null, t) - Math.min.apply(null, t) : Infinity;
    }
    return span("mdy") < span("dmy") ? "mdy" : "dmy";
  }

  function parseDate(s, fmt) {
    var p = dateParts(s);
    if (!p) return null;
    var y, mo, d;
    if (p.iso) { y = p.a; mo = p.b; d = p.c; }
    else if (p.named) { y = p.y; mo = p.mo; d = p.d; }
    else if (fmt === "mdy") { mo = p.a; d = p.b; y = p.c; }
    else { d = p.a; mo = p.b; y = p.c; }
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return { y: y, m: mo, d: d };
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(t, style) {
    if (style === "ofx") return t.y + pad(t.m) + pad(t.d);
    if (style === "us") return pad(t.m) + "/" + pad(t.d) + "/" + t.y;
    if (style === "eu") return pad(t.d) + "/" + pad(t.m) + "/" + t.y;
    return t.y + "-" + pad(t.m) + "-" + pad(t.d);
  }

  /* opts: {header, date, desc, amountMode: 'single'|'split', amount, debit, credit, balance, dateFmt, numFmt, flip} */
  function extract(rows, opts) {
    var body = opts.header ? rows.slice(1) : rows;
    var dateFmt = opts.dateFmt === "auto" ? guessDateFormat(body.map(function (r) { return r[opts.date]; })) : opts.dateFmt;
    var tx = [], skipped = [];
    body.forEach(function (r, i) {
      var line = i + (opts.header ? 2 : 1);
      var date = parseDate(r[opts.date], dateFmt);
      var amt;
      if (opts.amountMode === "split") {
        var de = parseNumber(r[opts.debit], opts.numFmt), cr = parseNumber(r[opts.credit], opts.numFmt);
        if (de === null && cr === null) amt = null;
        else amt = Math.round(((cr || 0) - Math.abs(de || 0)) * 100) / 100;
      } else amt = parseNumber(r[opts.amount], opts.numFmt);
      if (!date || amt === null) { skipped.push(line); return; }
      if (opts.flip) amt = -amt;
      var bal = opts.balance >= 0 ? parseNumber(r[opts.balance], opts.numFmt) : null;
      var desc = opts.desc.map(function (c) { return r[c] || ""; }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      tx.push({ line: line, date: date, desc: desc || "Transaction", amount: amt, balance: bal });
    });
    return { tx: tx, skipped: skipped, dateFmt: dateFmt };
  }

  /* Checks each row against the balance column. Works for oldest-first and newest-first files. */
  function checkBalances(tx) {
    var withBal = tx.filter(function (t) { return t.balance !== null; });
    if (withBal.length < 2) return null;
    function run(order) {
      var bad = [];
      for (var i = 1; i < order.length; i++) {
        var prev = order[i - 1], cur = order[i];
        if (prev.balance === null || cur.balance === null) continue;
        if (Math.abs(prev.balance + cur.amount - cur.balance) > 0.005) bad.push(cur.line);
      }
      return bad;
    }
    var fwd = run(tx), back = run(tx.slice().reverse());
    return fwd.length <= back.length ? { bad: fwd, checked: withBal.length - 1 } : { bad: back, checked: withBal.length - 1, reversed: true };
  }

  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
    }
    return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8);
  }

  function csvCell(s) {
    s = String(s);
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d.,]*$/.test(s)) s = "'" + s;  // no spreadsheet formulas from file text
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  function toQuickBooks(tx) {
    return "Date,Description,Amount\r\n" + tx.map(function (t) {
      return [fmtDate(t.date, "us"), csvCell(t.desc.slice(0, 1000)), t.amount.toFixed(2)].join(",");
    }).join("\r\n") + "\r\n";
  }

  function toXero(tx) {
    return "*Date,*Amount,Payee,Description,Reference,Check Number\r\n" + tx.map(function (t) {
      return [fmtDate(t.date, "eu"), t.amount.toFixed(2), csvCell(t.desc.slice(0, 50)), csvCell(t.desc), "", ""].join(",");
    }).join("\r\n") + "\r\n";
  }

  function toQIF(tx) {
    return "!Type:Bank\n" + tx.map(function (t) {
      return ["D" + fmtDate(t.date, "us"), "T" + t.amount.toFixed(2), "P" + t.desc.slice(0, 64), "M" + t.desc, "^"].join("\n");
    }).join("\n") + "\n";
  }

  function ascii(s) {
    return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "?") : s;
  }

  function toOFX(tx, currency, now) {
    var ds = tx.map(function (t) { return fmtDate(t.date, "ofx"); }).sort();
    var start = ds[0] || "19700101", end = ds[ds.length - 1] || start;
    var seen = {};
    var L = ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII", "CHARSET:1252",
      "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "", "<OFX>",
      "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>",
      "<DTSERVER>" + now + "<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>",
      "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS>",
      "<CURDEF>" + (currency || "USD").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) +
      "<BANKACCTFROM><BANKID>000000000<ACCTID>CSVIMPORT<ACCTTYPE>CHECKING</BANKACCTFROM>",
      "<BANKTRANLIST><DTSTART>" + start + "<DTEND>" + end];
    tx.forEach(function (t) {
      var name = ascii(t.desc).replace(/[<>&]/g, " ");
      var key = fmtDate(t.date, "iso") + "|" + name.toLowerCase() + "|" + t.amount.toFixed(2);
      var n = seen[key] || 0; seen[key] = n + 1;
      L.push("<STMTTRN><TRNTYPE>" + (t.amount > 0 ? "CREDIT" : "DEBIT") + "<DTPOSTED>" + fmtDate(t.date, "ofx") +
        "<TRNAMT>" + t.amount.toFixed(2) + "<FITID>" + hash(key + "|" + n) + "<NAME>" + name.slice(0, 32) +
        "<MEMO>" + name.slice(0, 255) + "</STMTTRN>");
    });
    var last = null;
    for (var i = tx.length - 1; i >= 0; i--) if (tx[i].balance !== null) { last = tx[i].balance; break; }
    L.push("</BANKTRANLIST>", "<LEDGERBAL><BALAMT>" + (last || 0).toFixed(2) + "<DTASOF>" + end + "</LEDGERBAL>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>");
    return L.join("\r\n");
  }

  function guessColumns(header) {
    var h = header.map(function (x) { return String(x || "").toLowerCase(); });
    function find(re) { for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; }
    return {
      date: find(/date|fecha|datum|data/),
      desc: find(/desc|concepto|detalle|payee|narrat|memo|details|particular|referencia|movimiento/),
      amount: find(/amount|importe|monto|valor|betrag|value/),
      debit: find(/debit|cargo|debe|withdraw|paid out|retiro|salida/),
      credit: find(/credit|abono|haber|deposit|paid in|ingreso|entrada/),
      balance: find(/balance|saldo/)
    };
  }

  var core = { detectDelimiter: detectDelimiter, parseCSV: parseCSV, parseNumber: parseNumber, parseDate: parseDate,
    guessDateFormat: guessDateFormat, extract: extract, checkBalances: checkBalances, toQuickBooks: toQuickBooks,
    toXero: toXero, toQIF: toQIF, toOFX: toOFX, guessColumns: guessColumns };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }

  // ---------- UI ----------
  var ES = document.documentElement.lang === "es";
  var T = ES ? {
    col: "Columna", none: "(ninguna)", rows: " movimientos leídos", skipped: "Filas que no se pudieron leer (fecha o importe): ",
    balOk: "Control de saldos: las {n} filas coinciden con la columna de saldo.",
    balBad: "Control de saldos: {b} de {n} filas no coinciden con el saldo. Revisa las filas: ",
    noData: "Pega un CSV o elige un archivo.", needCols: "Elige la columna de fecha y la de importe.",
    dl: "Descargar ", preview: "Vista previa (primeras 10 filas)", date: "Fecha", desc: "Descripción", amt: "Importe", bal: "Saldo"
  } : {
    col: "Column", none: "(none)", rows: " transactions read", skipped: "Rows that couldn't be read (date or amount): ",
    balOk: "Balance check: all {n} rows match the balance column.",
    balBad: "Balance check: {b} of {n} rows don't match the balance. Check rows: ",
    noData: "Paste a CSV or choose a file.", needCols: "Choose the date and amount columns.",
    dl: "Download ", preview: "Preview (first 10 rows)", date: "Date", desc: "Description", amt: "Amount", bal: "Balance"
  };
  var $ = function (id) { return document.getElementById(id); };
  var rows = [], lastResult = null;

  function fillSelect(sel, header, value, allowNone) {
    sel.innerHTML = "";
    if (allowNone) sel.add(new Option(T.none, "-1"));
    header.forEach(function (h, i) { sel.add(new Option((h || T.col + " " + (i + 1)).slice(0, 40), String(i))); });
    sel.value = String(value);
  }

  function load(text) {
    if (!text || !text.trim()) { rows = []; $("lpc-setup").classList.add("hidden"); return; }
    rows = core.parseCSV(text, core.detectDelimiter(text));
    var header = rows[0] || [];
    var hasHeader = header.some(function (c) { return c && core.parseNumber(c, "auto") === null && !core.parseDate(c, "dmy"); });
    $("lpc-header").checked = hasHeader;
    var names = hasHeader ? header : header.map(function (_, i) { return T.col + " " + (i + 1); });
    var g = hasHeader ? core.guessColumns(header) : { date: 0, desc: 1, amount: 2, debit: -1, credit: -1, balance: -1 };
    var split = g.amount < 0 && g.debit >= 0 && g.credit >= 0;
    fillSelect($("lpc-date"), names, Math.max(g.date, 0));
    fillSelect($("lpc-desc"), names, g.desc >= 0 ? g.desc : Math.min(1, names.length - 1));
    fillSelect($("lpc-desc2"), names, -1, true);
    fillSelect($("lpc-amount"), names, g.amount >= 0 ? g.amount : Math.min(2, names.length - 1));
    fillSelect($("lpc-debit"), names, g.debit, true);
    fillSelect($("lpc-credit"), names, g.credit, true);
    fillSelect($("lpc-balance"), names, g.balance, true);
    $("lpc-mode").value = split ? "split" : "single";
    $("lpc-setup").classList.remove("hidden");
    update();
  }

  function opts() {
    var desc = [+$("lpc-desc").value];
    if (+$("lpc-desc2").value >= 0) desc.push(+$("lpc-desc2").value);
    return { header: $("lpc-header").checked, date: +$("lpc-date").value, desc: desc, amountMode: $("lpc-mode").value,
      amount: +$("lpc-amount").value, debit: +$("lpc-debit").value, credit: +$("lpc-credit").value,
      balance: +$("lpc-balance").value, dateFmt: $("lpc-datefmt").value, numFmt: $("lpc-numfmt").value, flip: $("lpc-flip").checked };
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function update() {
    var split = $("lpc-mode").value === "split";
    $("lpc-single").classList.toggle("hidden", split);
    $("lpc-split").classList.toggle("hidden", !split);
    if (!rows.length) return;
    var o = opts();
    var r = core.extract(rows, o);
    lastResult = r;
    var msg = "<b>" + r.tx.length + "</b>" + T.rows;
    if (r.skipped.length) msg += "<br><span class='text-amber-700'>" + T.skipped + r.skipped.slice(0, 15).join(", ") + (r.skipped.length > 15 ? "…" : "") + "</span>";
    var chk = o.balance >= 0 ? core.checkBalances(r.tx) : null;
    if (chk) {
      msg += chk.bad.length
        ? "<br><span class='text-red-700 font-semibold'>" + T.balBad.replace("{b}", chk.bad.length).replace("{n}", chk.checked) + chk.bad.slice(0, 15).join(", ") + "</span>"
        : "<br><span class='text-green-700 font-semibold'>" + T.balOk.replace("{n}", chk.checked) + "</span>";
    }
    $("lpc-status").innerHTML = msg;
    var bad = chk ? chk.bad : [];
    $("lpc-preview").innerHTML = "<p class='text-sm text-slate-500 mb-2'>" + T.preview + "</p><table class='w-full text-sm'><tr class='text-left text-slate-500'><th class='pr-3'>#</th><th class='pr-3'>" + T.date + "</th><th class='pr-3'>" + T.desc + "</th><th class='pr-3 text-right'>" + T.amt + "</th><th class='text-right'>" + T.bal + "</th></tr>" +
      r.tx.slice(0, 10).map(function (t) {
        return "<tr class='" + (bad.indexOf(t.line) > -1 ? "bg-red-50" : "") + "'><td class='pr-3 text-slate-400'>" + t.line + "</td><td class='pr-3 whitespace-nowrap'>" + fmtDate(t.date, "iso") + "</td><td class='pr-3'>" + esc(t.desc.slice(0, 60)) +
          "</td><td class='pr-3 text-right " + (t.amount < 0 ? "text-red-700" : "text-green-700") + "'>" + t.amount.toFixed(2) + "</td><td class='text-right'>" + (t.balance === null ? "" : t.balance.toFixed(2)) + "</td></tr>";
      }).join("") + "</table>";
    $("lpc-download").disabled = !r.tx.length;
  }

  function download() {
    if (!lastResult || !lastResult.tx.length) { $("lpc-status").textContent = rows.length ? T.needCols : T.noData; return; }
    var fmt = $("lpc-format").value, tx = lastResult.tx, content, name, type = "text/csv";
    var d = new Date(), now = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    if (fmt === "ofx") { content = core.toOFX(tx, $("lpc-currency").value, now); name = "transactions.ofx"; type = "application/x-ofx"; }
    else if (fmt === "qif") { content = core.toQIF(tx); name = "transactions.qif"; type = "application/qif"; }
    else if (fmt === "xero") { content = core.toXero(tx); name = "xero-statement.csv"; }
    else { content = core.toQuickBooks(tx); name = "quickbooks-online.csv"; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    $("lpc-after").classList.remove("hidden");
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("lpc-file").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var txt = rd.result;
        if (txt.indexOf("�") > -1) { var r2 = new FileReader(); r2.onload = function () { $("lpc-text").value = r2.result; load(r2.result); }; r2.readAsText(f, "windows-1252"); return; }
        $("lpc-text").value = txt; load(txt);
      };
      rd.readAsText(f, "utf-8");
    });
    $("lpc-text").addEventListener("input", function () { load($("lpc-text").value); });
    ["lpc-header", "lpc-date", "lpc-desc", "lpc-desc2", "lpc-mode", "lpc-amount", "lpc-debit", "lpc-credit", "lpc-balance", "lpc-datefmt", "lpc-numfmt", "lpc-flip"]
      .forEach(function (id) { $(id).addEventListener("change", update); });
    $("lpc-format").addEventListener("change", function () { $("lpc-cur-wrap").classList.toggle("hidden", $("lpc-format").value !== "ofx"); });
    $("lpc-download").addEventListener("click", download);
    $("lpc-sample").addEventListener("click", function (e) {
      e.preventDefault();
      var s = ES
        ? "Fecha;Concepto;Importe;Saldo\n02/01/2026;Pago con tarjeta papelería;-45,90;2.254,10\n03/01/2026;Transferencia cliente FAC-104;1.250,00;3.504,10\n05/01/2026;Comisión bancaria;-12,00;3.492,10\n08/01/2026;Alquiler;-800,00;2.692,10\n"
        : "Date,Description,Amount,Balance\n01/02/2026,Card payment office supplies,-45.90,2254.10\n01/03/2026,Client transfer INV-104,1250.00,3504.10\n01/05/2026,Bank fee,-12.00,3492.10\n01/08/2026,Rent,-800.00,2692.10\n";
      $("lpc-text").value = s; load(s);
    });
  });
})();
