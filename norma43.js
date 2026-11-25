/* LedgerProof free Norma 43 (AEB Cuaderno 43) converter -> Excel, CSV, OFX, QIF, QuickBooks Online, Xero.
   Checks the file against its own totals. Runs entirely in the browser. Needs ofx-converter.js (writers). */
(function () {
  "use strict";
  var X = typeof module !== "undefined" && module.exports ? require("./ofx-converter.js") : window.LPOFX;

  var COMUNES = {
    "01": "Talones - reintegros", "02": "Abonarés - entregas - ingresos", "03": "Domiciliados - recibos - letras - pagos por su cuenta",
    "04": "Giros - transferencias - traspasos - cheques", "05": "Amortizaciones préstamos, créditos", "06": "Remesas efectos",
    "07": "Suscripciones - div. pasivos - canjes", "08": "Div. cupones - prima junta - amortizaciones", "09": "Operaciones de bolsa / compraventa valores",
    "10": "Cheques gasolina", "11": "Cajero automático", "12": "Tarjetas de crédito - débito", "13": "Operaciones extranjero",
    "14": "Devoluciones e impagados", "15": "Nóminas - seguros sociales", "16": "Timbres - corretaje - póliza",
    "17": "Intereses - comisiones - custodia - gastos e impuestos", "98": "Anulaciones - correcciones asiento", "99": "Varios"
  };
  var DIVISAS = { "978": "EUR", "840": "USD", "826": "GBP", "756": "CHF", "392": "JPY", "124": "CAD", "036": "AUD", "554": "NZD",
    "208": "DKK", "578": "NOK", "752": "SEK", "484": "MXN", "032": "ARS", "152": "CLP", "170": "COP", "604": "PEN", "986": "BRL", "858": "UYU" };

  function r2(v) { return Math.round(v * 100) / 100; }
  function amt(s) { return /^\d{14}$/.test(s) ? parseInt(s, 10) / 100 : null; }
  function date6(s) {
    var m = /^(\d{2})(\d{2})(\d{2})$/.exec(s || "");
    if (!m) return null;
    var y = 2000 + +m[1], mo = +m[2], d = +m[3];
    var x = new Date(Date.UTC(y, mo - 1, d));
    return mo >= 1 && mo <= 12 && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d ? { y: y, m: mo, d: d } : null;
  }
  function f(line, from, to) { return line.slice(from - 1, to); }

  function splitRecords(text) {
    text = String(text || "").replace(/^﻿/, "");
    var lines = text.split(/\r\n|\n|\r/).filter(function (l) { return l.trim(); });
    // some exports have no line breaks: fixed 80-byte records back to back
    if (lines.length === 1 && lines[0].length > 80 && lines[0].length % 80 === 0) {
      var one = lines[0]; lines = [];
      for (var i = 0; i < one.length; i += 80) lines.push(one.slice(i, i + 80));
    }
    return lines.map(function (l) { l = l.replace(/\s+$/, ""); while (l.length < 80) l += " "; return l; });
  }

  function looksLikeN43(text) {
    var recs = splitRecords(text);
    return recs.length >= 2 && /^11\d{18}/.test(recs[0]) && recs.some(function (l) { return /^(22|33)/.test(l); });
  }

  function parse(text) {
    var recs = splitRecords(text);
    var accounts = [], cur = null, last = null, errors = [], eof = null;
    recs.forEach(function (l, i) {
      var code = l.slice(0, 2), line = i + 1;
      if (code === "11") {
        cur = {
          bank: f(l, 3, 6), branch: f(l, 7, 10), number: f(l, 11, 20), start: date6(f(l, 21, 26)), end: date6(f(l, 27, 32)),
          opening: amt(f(l, 34, 47)), currencyCode: f(l, 48, 50), name: f(l, 52, 77).trim(), tx: [], footer: null, line: line
        };
        if (cur.opening !== null && f(l, 33, 33) === "1") cur.opening = -cur.opening;
        if (cur.opening === null) errors.push({ line: line, what: "opening" });
        cur.currency = DIVISAS[cur.currencyCode] || "";
        cur.id = cur.bank + " " + cur.branch + " " + cur.number;
        accounts.push(cur); last = null;
      } else if (code === "22") {
        if (!cur) { errors.push({ line: line, what: "noHeader" }); return; }
        var a = amt(f(l, 29, 42)), key = f(l, 28, 28), dOp = date6(f(l, 11, 16));
        if (a === null || (key !== "1" && key !== "2") || !dOp) { errors.push({ line: line, what: "movement" }); last = null; return; }
        var cc = f(l, 23, 24);
        last = { line: line, date: dOp, valueDate: date6(f(l, 17, 22)), common: cc, commonText: COMUNES[cc] || "", own: f(l, 25, 27).trim(),
          amount: key === "1" ? -a : a, doc: f(l, 43, 52).replace(/^0+(?=\d)/, "").trim(), ref1: f(l, 53, 64).trim(), ref2: f(l, 65, 80).trim(),
          concepts: [], foreign: null, branch: f(l, 7, 10).trim() };
        if (/^0*$/.test(last.doc)) last.doc = "";
        if (/^0*$/.test(last.ref1)) last.ref1 = "";
        cur.tx.push(last);
      } else if (code === "23") {
        if (!last) return;
        var c1 = f(l, 5, 42).trim(), c2 = f(l, 43, 80).trim();
        if (c1) last.concepts.push(c1);
        if (c2) last.concepts.push(c2);
      } else if (code === "24") {
        if (last) last.foreign = { currency: DIVISAS[f(l, 5, 7)] || f(l, 5, 7), amount: amt(f(l, 8, 21)) };
      } else if (code === "33") {
        if (!cur) { errors.push({ line: line, what: "noHeader" }); return; }
        var fin = amt(f(l, 60, 73));
        if (fin !== null && f(l, 59, 59) === "1") fin = -fin;
        cur.footer = { nDebit: parseInt(f(l, 21, 25), 10), totDebit: amt(f(l, 26, 39)), nCredit: parseInt(f(l, 40, 44), 10),
          totCredit: amt(f(l, 45, 58)), closing: fin, line: line };
        last = null;
      } else if (code === "88") {
        eof = { records: parseInt(f(l, 21, 26), 10), line: line, before: i };
      } else {
        errors.push({ line: line, what: "unknown" });
      }
    });
    var tx = [];
    accounts.forEach(function (acc) {
      var bal = acc.opening || 0;
      acc.tx.forEach(function (t) {
        bal = r2(bal + t.amount); t.balance = bal;
        t.desc = (t.concepts.join(" ") || t.ref2 || t.commonText || "Movimiento").replace(/\s+/g, " ").trim();
        t.account = acc.id;
        tx.push(t);
      });
      acc.computedClosing = bal;
    });
    return { accounts: accounts, tx: tx, errors: errors, eof: eof, records: recs.length };
  }

  /* Every check the file allows. Each item: {ok: bool, key, account?, expected?, got?} */
  function check(res) {
    var out = [];
    res.accounts.forEach(function (acc, idx) {
      var deb = acc.tx.filter(function (t) { return t.amount < 0; }), cre = acc.tx.filter(function (t) { return t.amount > 0; });
      var sd = r2(deb.reduce(function (s, t) { return s - t.amount; }, 0)), sc = r2(cre.reduce(function (s, t) { return s + t.amount; }, 0));
      var ft = acc.footer;
      if (!ft) { out.push({ ok: false, key: "noFooter", account: acc.id }); return; }
      out.push({ ok: ft.nDebit === deb.length && ft.nCredit === cre.length, key: "counts", account: acc.id,
        expected: ft.nDebit + "/" + ft.nCredit, got: deb.length + "/" + cre.length });
      out.push({ ok: Math.abs(ft.totDebit - sd) < 0.005, key: "debits", account: acc.id, expected: ft.totDebit, got: sd });
      out.push({ ok: Math.abs(ft.totCredit - sc) < 0.005, key: "credits", account: acc.id, expected: ft.totCredit, got: sc });
      out.push({ ok: Math.abs(ft.closing - acc.computedClosing) < 0.005, key: "closing", account: acc.id, expected: ft.closing, got: acc.computedClosing });
      // same account, consecutive periods: opening must equal the previous closing
      for (var j = idx - 1; j >= 0; j--) {
        var prev = res.accounts[j];
        if (prev.id === acc.id && prev.footer) {
          out.push({ ok: Math.abs(prev.footer.closing - acc.opening) < 0.005, key: "chain", account: acc.id, expected: prev.footer.closing, got: acc.opening });
          break;
        }
      }
    });
    if (res.eof) out.push({ ok: res.eof.records === res.eof.before, key: "records", expected: res.eof.records, got: res.eof.before });
    else out.push({ ok: false, key: "noEof" });
    return out;
  }

  function columns(es) {
    return es ? [
      { label: "Fecha operación", width: 12, type: "d" }, { label: "Fecha valor", width: 12, type: "d" }, { label: "Concepto", width: 44, type: "s" },
      { label: "Importe", width: 14, type: "n", sum: true }, { label: "Saldo", width: 14, type: "n" }, { label: "Concepto común", width: 30, type: "s" },
      { label: "Concepto propio", width: 10, type: "s" }, { label: "Nº documento", width: 14, type: "s" }, { label: "Referencia 1", width: 14, type: "s" },
      { label: "Referencia 2", width: 18, type: "s" }, { label: "Divisa origen", width: 10, type: "s" }, { label: "Importe divisa origen", width: 14, type: "n" },
      { label: "Cuenta", width: 22, type: "s" }
    ] : [
      { label: "Transaction date", width: 12, type: "d" }, { label: "Value date", width: 12, type: "d" }, { label: "Description", width: 44, type: "s" },
      { label: "Amount", width: 14, type: "n", sum: true }, { label: "Balance", width: 14, type: "n" }, { label: "Common concept", width: 30, type: "s" },
      { label: "Bank concept", width: 10, type: "s" }, { label: "Document no.", width: 14, type: "s" }, { label: "Reference 1", width: 14, type: "s" },
      { label: "Reference 2", width: 18, type: "s" }, { label: "Original currency", width: 10, type: "s" }, { label: "Original amount", width: 14, type: "n" },
      { label: "Account", width: 22, type: "s" }
    ];
  }
  function rowOf(t) {
    return [t.date, t.valueDate, t.desc, t.amount, t.balance, t.common + (t.commonText ? " " + t.commonText : ""), t.own, t.doc, t.ref1, t.ref2,
      t.foreign ? t.foreign.currency : "", t.foreign && t.foreign.amount !== null ? (t.amount < 0 ? -t.foreign.amount : t.foreign.amount) : null, t.account];
  }
  function toXLSX(res, es) { return X.sheetXLSX(columns(es), res.tx.map(rowOf), es ? "Movimientos" : "Transactions", "Total"); }
  function toCSV(res, es, semicolon) {
    var d = semicolon ? ";" : ",", cols = columns(es);
    return "﻿" + cols.map(function (c) { return X.csvCell(c.label, d); }).join(d) + "\r\n" + res.tx.map(function (t) {
      return rowOf(t).map(function (v, i) {
        if (cols[i].type === "d") return v ? X.fmtDate(v, "iso") : "";
        if (cols[i].type === "n") { if (v === null || v === undefined) return ""; var s = v.toFixed(2); return semicolon ? s.replace(".", ",") : s; }
        return X.csvCell(v == null ? "" : v, d);
      }).join(d);
    }).join("\r\n") + "\r\n";
  }
  /* For the generic writers (OFX/QIF/QuickBooks/Xero): name = description, memo = references */
  function generic(res) {
    return res.tx.map(function (t) {
      return { date: t.date, name: t.desc.slice(0, 64), memo: [t.desc, t.ref2].filter(Boolean).join(" ").slice(0, 255), desc: t.desc,
        amount: t.amount, ref: t.doc, id: "", type: t.amount < 0 ? "DEBIT" : "CREDIT", account: t.account, category: "", balance: t.balance };
    });
  }

  var core = { parse: parse, check: check, looksLikeN43: looksLikeN43, toXLSX: toXLSX, toCSV: toCSV, generic: generic, COMUNES: COMUNES };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }

  // ---------- UI ----------
  var ES = document.documentElement.lang === "es";
  var T = ES ? {
    notN43: "No parece un fichero Norma 43: la primera línea debe empezar por 11 (cabecera de cuenta).", noData: "Elige un fichero o pega su contenido.",
    read: " movimientos en ", accounts: " cuenta(s)", from: " del ", to: " al ", opening: "Saldo inicial", closing: "saldo final",
    counts: "Número de apuntes (cargos/abonos)", debits: "Total de cargos", credits: "Total de abonos", closingK: "Saldo final = saldo inicial + abonos − cargos",
    chain: "Saldo inicial igual al saldo final del período anterior", records: "Número de registros (registro 88)", noFooter: "Falta el registro final de cuenta (33)",
    noEof: "Falta el registro de fin de fichero (88)", expected: "el fichero dice ", got: "suman ", allOk: "Todo cuadra: el fichero está completo.",
    someBad: "Hay diferencias: el fichero puede estar incompleto o dañado. Revisa las líneas marcadas antes de importarlo.",
    errLines: "Líneas que no se pudieron leer: ", preview: "Vista previa (primeras 10 filas)", date: "Fecha", desc: "Concepto", amt: "Importe", bal: "Saldo", account: "Cuenta"
  } : {
    notN43: "This doesn't look like a Norma 43 file: the first line must start with 11 (account header).", noData: "Choose a file or paste its contents.",
    read: " transactions in ", accounts: " account(s)", from: " from ", to: " to ", opening: "Opening balance", closing: "closing balance",
    counts: "Number of debits/credits", debits: "Total debits", credits: "Total credits", closingK: "Closing = opening + credits − debits",
    chain: "Opening equals the previous period's closing", records: "Record count (record 88)", noFooter: "Account end record (33) is missing",
    noEof: "End-of-file record (88) is missing", expected: "file says ", got: "rows add up to ", allOk: "Everything matches: the file is complete.",
    someBad: "There are differences: the file may be incomplete or damaged. Check the flagged lines before importing it.",
    errLines: "Lines that couldn't be read: ", preview: "Preview (first 10 rows)", date: "Date", desc: "Description", amt: "Amount", bal: "Balance", account: "Account"
  };
  var $ = function (id) { return document.getElementById(id); };
  var result = null;
  function money(v) { return typeof v === "number" ? v.toLocaleString(ES ? "es-ES" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }) : v; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function mask(id) { return id.replace(/^(.*)(\d{4})$/, function (_, a, b) { return a.replace(/\d/g, "•") + b; }); }

  function load(text) {
    result = null;
    $("lpn-setup").classList.add("hidden");
    if (!String(text || "").trim()) { $("lpn-msg").textContent = ""; return; }
    if (!core.looksLikeN43(text)) { $("lpn-msg").innerHTML = "<span class='text-red-700'>" + T.notN43 + "</span>"; return; }
    $("lpn-msg").textContent = "";
    result = core.parse(text);
    var checks = core.check(result), bad = checks.filter(function (c) { return !c.ok; });
    var ds = result.tx.map(function (t) { return X.fmtDate(t.date, "iso"); }).sort();
    var msg = "<b>" + result.tx.length + "</b>" + T.read + result.accounts.length + T.accounts + (ds.length ? T.from + ds[0] + T.to + ds[ds.length - 1] : "");
    result.accounts.forEach(function (a) {
      msg += "<br>" + T.account + " " + esc(mask(a.id)) + (a.name ? " (" + esc(a.name) + ")" : "") + ": " + T.opening + " <b>" + money(a.opening) + "</b> → " + T.closing + " <b>" + money(a.computedClosing) + "</b> " + esc(a.currency);
    });
    msg += "<ul class='mt-2 space-y-0.5'>" + checks.map(function (c) {
      var det = c.ok ? "" : (c.expected !== undefined ? " — " + T.expected + money(c.expected) + ", " + T.got + money(c.got) : "");
      return "<li class='" + (c.ok ? "text-green-700" : "text-red-700 font-semibold") + "'>" + (c.ok ? "✓ " : "✗ ") + T[c.key === "closing" ? "closingK" : c.key] + (c.account && result.accounts.length > 1 ? " (" + esc(mask(c.account)) + ")" : "") + det + "</li>";
    }).join("") + "</ul>";
    msg += "<p class='mt-2 font-semibold " + (bad.length ? "text-red-700" : "text-green-700") + "'>" + (bad.length ? T.someBad : T.allOk) + "</p>";
    if (result.errors.length) msg += "<p class='text-amber-700'>" + T.errLines + result.errors.slice(0, 15).map(function (e) { return e.line; }).join(", ") + "</p>";
    $("lpn-status").innerHTML = msg;
    $("lpn-preview").innerHTML = "<p class='text-sm text-slate-500 mb-2'>" + T.preview + "</p><table class='w-full text-sm'><tr class='text-left text-slate-500'><th class='pr-3'>" + T.date + "</th><th class='pr-3'>" + T.desc + "</th><th class='pr-3 text-right'>" + T.amt + "</th><th class='text-right'>" + T.bal + "</th></tr>" +
      result.tx.slice(0, 10).map(function (t) {
        return "<tr><td class='pr-3 whitespace-nowrap'>" + X.fmtDate(t.date, "iso") + "</td><td class='pr-3'>" + esc(t.desc.slice(0, 60)) + "</td><td class='pr-3 text-right " + (t.amount < 0 ? "text-red-700" : "text-green-700") + "'>" + t.amount.toFixed(2) + "</td><td class='text-right'>" + t.balance.toFixed(2) + "</td></tr>";
      }).join("") + "</table>";
    $("lpn-download").disabled = !result.tx.length;
    $("lpn-setup").classList.remove("hidden");
  }

  function download() {
    if (!result || !result.tx.length) { $("lpn-msg").textContent = T.noData; return; }
    var fmt = $("lpn-format").value, content, name, type = "text/csv;charset=utf-8", g;
    var d = new Date(), now = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var base = ES ? "movimientos" : "transactions";
    if (fmt === "xlsx") { content = core.toXLSX(result, ES); name = base + ".xlsx"; type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
    else if (fmt === "csv-eu") { content = core.toCSV(result, ES, true); name = base + ".csv"; }
    else if (fmt === "csv") { content = core.toCSV(result, ES, false); name = base + ".csv"; }
    else {
      g = core.generic(result);
      if (fmt === "qbo") content = X.toQuickBooks(g), name = "quickbooks-online.csv";
      else if (fmt === "xero") content = X.toXero(g), name = "xero-statement.csv";
      else if (fmt === "qif") { content = X.toQIF(g, false); name = base + ".qif"; type = "application/qif"; }
      else { content = X.toOFX(g, (result.accounts[0] && result.accounts[0].currency) || "EUR", now); name = base + ".ofx"; type = "application/x-ofx"; }
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    $("lpn-after").classList.remove("hidden");
  }

  function sample() {
    function p(s, n, c) { s = String(s); while (s.length < n) s = (c || " ") === " " ? s + " " : c + s; return s.slice(0, n); }
    function z(v, n) { return p(Math.round(Math.abs(v) * 100), n, "0"); }
    var mv = [["260102", 12, "1", 45.90, ES ? "COMPRA TARJETA PAPELERIA CENTRAL" : "CARD PURCHASE OFFICE SUPPLIES"], ["260103", 4, "2", 1250, ES ? "TRANSFERENCIA DE CLIENTE FAC-104" : "TRANSFER FROM CLIENT INV-104"],
      ["260105", 17, "1", 12, ES ? "COMISION MANTENIMIENTO" : "MAINTENANCE FEE"], ["260108", 3, "1", 800, ES ? "RECIBO ALQUILER ENERO" : "DIRECT DEBIT RENT JANUARY"]];
    var L = ["11" + "0000" + "0001" + "0000123456" + "260101" + "260131" + "2" + z(2300, 14) + "978" + "3" + p(ES ? "EMPRESA EJEMPLO SL" : "SAMPLE COMPANY", 26) + "   "];
    var nd = 0, td = 0, nc = 0, tc = 0, bal = 2300;
    mv.forEach(function (m, i) {
      L.push("22" + "    " + "0001" + m[0] + m[0] + p(m[1], 2, "0") + "001" + m[2] + z(m[3], 14) + p(i + 1, 10, "0") + p("", 12, "0") + p("", 16));
      L.push("23" + "01" + p(m[4], 38) + p("", 38));
      if (m[2] === "1") { nd++; td += m[3]; bal -= m[3]; } else { nc++; tc += m[3]; bal += m[3]; }
    });
    L.push("33" + "0000" + "0001" + "0000123456" + p(nd, 5, "0") + z(td, 14) + p(nc, 5, "0") + z(tc, 14) + "2" + z(bal, 14) + "978" + "    ");
    L.push("88" + p("", 18, "9") + p(L.length, 6, "0") + p("", 54));
    return L.join("\r\n") + "\r\n";
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("lpn-file").addEventListener("change", function (e) {
      var file = e.target.files[0]; if (!file) return;
      var rd = new FileReader();
      rd.onload = function () {
        var txt = rd.result;
        if (txt.indexOf("�") > -1) { var r2b = new FileReader(); r2b.onload = function () { $("lpn-text").value = r2b.result; load(r2b.result); }; r2b.readAsText(file, "windows-1252"); return; }
        $("lpn-text").value = txt; load(txt);
      };
      rd.readAsText(file, "utf-8");
    });
    $("lpn-text").addEventListener("input", function () { load($("lpn-text").value); });
    $("lpn-download").addEventListener("click", download);
    $("lpn-sample").addEventListener("click", function (e) { e.preventDefault(); var s = sample(); $("lpn-text").value = s; load(s); });
  });
})();
