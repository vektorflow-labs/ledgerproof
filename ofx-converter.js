/* LedgerProof free OFX / QFX / QBO / QIF converter: -> Excel (.xlsx), CSV, QuickBooks Online CSV, Xero CSV, QIF, OFX.
   Runs entirely in the browser. Nothing is uploaded. */
(function () {
  "use strict";

  // ---------- core (pure functions, also used by tests under Node) ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(t, style) {
    if (style === "ofx") return t.y + pad(t.m) + pad(t.d);
    if (style === "us") return pad(t.m) + "/" + pad(t.d) + "/" + t.y;
    if (style === "eu") return pad(t.d) + "/" + pad(t.m) + "/" + t.y;
    return t.y + "-" + pad(t.m) + "-" + pad(t.d);
  }
  function validDate(y, m, d) {
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var x = new Date(Date.UTC(y, m - 1, d));
    return x.getUTCMonth() === m - 1 ? { y: y, m: m, d: d } : null;
  }

  function detectFormat(text) {
    if (/<OFX>|OFXHEADER|<\?OFX/i.test(text)) return "ofx";
    if (/^\s*!Type:/im.test(text) || (/^\^\s*$/m.test(text) && /^D.+$/m.test(text) && /^[TU].+$/m.test(text))) return "qif";
    return null;
  }

  function decodeEntities(s) {
    return s.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); }).replace(/&amp;/gi, "&");
  }

  function tag(block, name) {
    var m = new RegExp("<" + name + ">([^<\\r\\n]*)", "i").exec(block);
    return m ? decodeEntities(m[1]).trim() : "";
  }

  function ofxAmount(s) {
    s = String(s || "").replace(/\s/g, "");
    if (!s) return null;
    if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");      // some European banks write -12,50
    else s = s.replace(/,/g, "");
    var v = parseFloat(s);
    return isFinite(v) ? Math.round(v * 100) / 100 : null;
  }

  function ofxDate(s) {
    var m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || "").trim());
    return m ? validDate(+m[1], +m[2], +m[3]) : null;
  }

  function parseOFX(text) {
    var stmts = [], re = /<(CC)?STMTRS>([\s\S]*?)(<\/(CC)?STMTRS>|(?=<(CC)?STMTRS>)|$)/gi, m;
    while ((m = re.exec(text)) !== null) { if (m[2]) stmts.push({ cc: !!m[1], body: m[2] }); if (!m[0]) break; }
    if (!stmts.length) stmts.push({ cc: false, body: text });
    var tx = [], accounts = [], bad = 0;
    stmts.forEach(function (st, si) {
      var acct = tag(st.body, "ACCTID") || ("Account " + (si + 1));
      var cur = tag(st.body, "CURDEF");
      var lb = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(st.body);
      var info = { id: acct, currency: cur, creditCard: st.cc, closing: lb ? ofxAmount(tag(lb[1], "BALAMT")) : null,
        closingDate: lb ? ofxDate(tag(lb[1], "DTASOF")) : null, count: 0, net: 0 };
      var tre = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi, t;
      while ((t = tre.exec(st.body)) !== null) {
        var b = t[1];
        if (!b) continue;
        var date = ofxDate(tag(b, "DTPOSTED")) || ofxDate(tag(b, "DTUSER"));
        var amt = ofxAmount(tag(b, "TRNAMT"));
        if (!date || amt === null) { bad++; continue; }
        var name = tag(b, "NAME") || tag(b, "PAYEEID"), memo = tag(b, "MEMO");
        if (!name) { var p = /<PAYEE>([\s\S]*?)<\/PAYEE>/i.exec(b); if (p) name = tag(p[1], "NAME"); }
        tx.push({ date: date, name: name, memo: memo, desc: (name && memo && memo !== name ? name + " " + memo : name || memo || "Transaction").replace(/\s+/g, " ").trim(),
          amount: amt, type: tag(b, "TRNTYPE").toUpperCase(), ref: tag(b, "CHECKNUM") || tag(b, "REFNUM"), id: tag(b, "FITID"),
          account: acct, category: "" });
        info.count++; info.net = Math.round((info.net + amt) * 100) / 100;
      }
      accounts.push(info);
    });
    return { format: "ofx", tx: tx, accounts: accounts.filter(function (a) { return a.count || a.closing !== null; }), unreadable: bad };
  }

  function qifDateParts(s) {
    s = String(s || "").trim().replace(/'\s*/g, "/").replace(/\s+/g, "");
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) return { iso: true, a: +m[2], b: +m[3], y: +m[1] };
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if (!m) return null;
    var y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    return { a: +m[1], b: +m[2], y: y };
  }
  function guessQifDateFormat(values) {
    var mdy = 0, dmy = 0;
    values.forEach(function (v) { var p = qifDateParts(v); if (!p || p.iso) return; if (p.a > 12) dmy++; if (p.b > 12) mdy++; });
    return dmy > mdy ? "dmy" : "mdy";
  }
  function qifDate(s, fmt) {
    var p = qifDateParts(s);
    if (!p) return null;
    if (p.iso) return validDate(p.y, p.a, p.b);
    return fmt === "dmy" ? validDate(p.y, p.b, p.a) : validDate(p.y, p.a, p.b);
  }
  function qifAmount(s) {
    s = String(s || "").trim().replace(/\s/g, "");
    if (!s) return null;
    if (/^[+-]?\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s) || /^[+-]?\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    var v = parseFloat(s);
    return isFinite(v) ? Math.round(v * 100) / 100 : null;
  }

  function parseQIF(text, dateFmt) {
    var recs = [], cur = {}, account = "", type = "Bank";
    text.split(/\r?\n/).forEach(function (raw) {
      var l = raw.trimEnd();
      if (!l) return;
      if (l.charAt(0) === "!") {
        var mt = /^!Type:(\w+)/i.exec(l); if (mt) type = mt[1];
        else if (/^!Account/i.test(l)) type = "Account";
        cur = {}; return;
      }
      if (l === "^") {
        if (type === "Account") { if (cur.N !== undefined) account = cur.N; }
        else if (cur.D !== undefined || cur.T !== undefined || cur.U !== undefined) recs.push(cur);
        cur = {}; return;
      }
      var k = l.charAt(0), v = l.slice(1).trim();
      if (k === "S" || k === "$" || k === "E") return;          // split lines: keep the record total
      if (cur[k] === undefined) cur[k] = v;
      cur._type = type; cur._account = account;
    });
    if (cur.D !== undefined && cur.T !== undefined) recs.push(cur);
    var fmt = dateFmt && dateFmt !== "auto" ? dateFmt : guessQifDateFormat(recs.map(function (r) { return r.D; }));
    var tx = [], bad = 0;
    recs.forEach(function (r) {
      var date = qifDate(r.D, fmt), amt = qifAmount(r.T !== undefined ? r.T : r.U);
      if (!date || amt === null) { bad++; return; }
      var name = r.P || "", memo = r.M || "";
      tx.push({ date: date, name: name, memo: memo, desc: (name && memo && memo !== name ? name + " " + memo : name || memo || "Transaction").replace(/\s+/g, " ").trim(),
        amount: amt, type: amt < 0 ? "DEBIT" : "CREDIT", ref: r.N || "", id: "", account: r._account || "", category: r.L || "" });
    });
    var net = tx.reduce(function (s, t) { return Math.round((s + t.amount) * 100) / 100; }, 0);
    return { format: "qif", tx: tx, accounts: [{ id: "", currency: "", closing: null, count: tx.length, net: net }], unreadable: bad, dateFmt: fmt };
  }

  function parse(text, dateFmt) {
    text = String(text || "").replace(/^﻿/, "");
    var f = detectFormat(text);
    if (f === "ofx") return parseOFX(text);
    if (f === "qif") return parseQIF(text, dateFmt);
    return null;
  }

  /* Checks that don't need a balance column: duplicate bank IDs, repeated rows, totals, implied opening balance. */
  function summarize(res) {
    var tin = 0, tout = 0, ids = {}, dupIds = [], rows = {}, repeats = [];
    res.tx.forEach(function (t, i) {
      if (t.amount > 0) tin += t.amount; else tout += t.amount;
      if (t.id) { var k = t.account + "|" + t.id; if (ids[k] !== undefined) dupIds.push(i + 1); else ids[k] = i; }
      var rk = t.account + "|" + fmtDate(t.date, "iso") + "|" + t.amount.toFixed(2) + "|" + t.desc.toLowerCase();
      if (rows[rk] !== undefined) repeats.push(i + 1); else rows[rk] = i;
    });
    var ds = res.tx.map(function (t) { return fmtDate(t.date, "iso"); }).sort();
    return {
      count: res.tx.length, moneyIn: Math.round(tin * 100) / 100, moneyOut: Math.round(tout * 100) / 100,
      first: ds[0] || "", last: ds[ds.length - 1] || "", duplicateIds: dupIds, repeatedRows: repeats,
      accounts: res.accounts.map(function (a) {
        return { id: a.id, currency: a.currency, count: a.count, net: a.net, closing: a.closing,
          opening: a.closing === null ? null : Math.round((a.closing - a.net) * 100) / 100 };
      })
    };
  }

  function csvCell(s, d) {
    s = String(s);
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d.,]*$/.test(s)) s = "'" + s;  // no spreadsheet formulas from file text
    return (s.indexOf(d) > -1 || /["\n\r]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  /* Plain CSV for Excel/Sheets. delimiter ";" + decimal "," for Spanish/European Excel. */
  function toCSV(tx, delimiter, decimalComma, labels) {
    var d = delimiter || ",";
    var L = labels || ["Date", "Description", "Memo", "Amount", "Type", "Check/Ref", "Category", "Account", "Bank ID"];
    return "﻿" + L.join(d) + "\r\n" + tx.map(function (t) {
      var a = t.amount.toFixed(2);
      if (decimalComma) a = a.replace(".", ",");
      return [fmtDate(t.date, "iso"), t.name || t.desc, t.memo, a, t.type, t.ref, t.category, t.account, t.id].map(function (c) { return csvCell(c, d); }).join(d);
    }).join("\r\n") + "\r\n";
  }

  function toQuickBooks(tx) {
    return "Date,Description,Amount\r\n" + tx.map(function (t) {
      return [fmtDate(t.date, "us"), csvCell(t.desc.slice(0, 1000), ","), t.amount.toFixed(2)].join(",");
    }).join("\r\n") + "\r\n";
  }

  function toXero(tx) {
    return "*Date,*Amount,Payee,Description,Reference,Check Number\r\n" + tx.map(function (t) {
      return [fmtDate(t.date, "eu"), t.amount.toFixed(2), csvCell((t.name || t.desc).slice(0, 50), ","), csvCell(t.memo || t.desc, ","), csvCell(t.id ? "" : t.ref, ","), csvCell(/^\d+$/.test(t.ref) ? t.ref : "", ",")].join(",");
    }).join("\r\n") + "\r\n";
  }

  function toQIF(tx, creditCard) {
    return "!Type:" + (creditCard ? "CCard" : "Bank") + "\n" + tx.map(function (t) {
      var L = ["D" + fmtDate(t.date, "us"), "T" + t.amount.toFixed(2)];
      if (t.ref) L.push("N" + t.ref);
      L.push("P" + (t.name || t.desc).slice(0, 64));
      if (t.memo) L.push("M" + t.memo);
      if (t.category) L.push("L" + t.category);
      L.push("^");
      return L.join("\n");
    }).join("\n") + "\n";
  }

  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
    }
    return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8);
  }
  function ascii(s) {
    return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "?") : s;
  }

  function toOFX(tx, currency, now) {
    var ds = tx.map(function (t) { return fmtDate(t.date, "ofx"); }).sort();
    var start = ds[0] || "19700101", end = ds[ds.length - 1] || start, seen = {};
    var L = ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII", "CHARSET:1252",
      "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "", "<OFX>",
      "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>",
      "<DTSERVER>" + now + "<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>",
      "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS>",
      "<CURDEF>" + (currency || "USD").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) +
      "<BANKACCTFROM><BANKID>000000000<ACCTID>QIFIMPORT<ACCTTYPE>CHECKING</BANKACCTFROM>",
      "<BANKTRANLIST><DTSTART>" + start + "<DTEND>" + end];
    tx.forEach(function (t) {
      var name = ascii(t.name || t.desc).replace(/[<>&]/g, " "), memo = ascii(t.memo || t.desc).replace(/[<>&]/g, " ");
      var key = fmtDate(t.date, "iso") + "|" + name.toLowerCase() + "|" + t.amount.toFixed(2);
      var n = seen[key] || 0; seen[key] = n + 1;
      L.push("<STMTTRN><TRNTYPE>" + (t.amount > 0 ? "CREDIT" : "DEBIT") + "<DTPOSTED>" + fmtDate(t.date, "ofx") +
        "<TRNAMT>" + t.amount.toFixed(2) + "<FITID>" + hash(key + "|" + n) + (/^\d+$/.test(t.ref) ? "<CHECKNUM>" + t.ref : "") +
        "<NAME>" + name.slice(0, 32) + "<MEMO>" + memo.slice(0, 255) + "</STMTTRN>");
    });
    L.push("</BANKTRANLIST>", "<LEDGERBAL><BALAMT>0.00<DTASOF>" + end + "</LEDGERBAL>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>");
    return L.join("\r\n");
  }

  // ---- minimal .xlsx writer (stored ZIP, inline strings, real dates and numbers) ----
  var CRC = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, "utf8"));
  }
  function zip(files) {
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = utf8(f.name), data = utf8(f.data), crc = crc32(data);
      var head = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(Uint8Array.from(head), name, data);
      central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)), name);
      offset += head.length + name.length + data.length;
    });
    var csize = 0;
    central.forEach(function (c, i) { if (i % 2 === 0) { parts.push(Uint8Array.from(c)); csize += c.length; } else { parts.push(c); csize += c.length; } });
    parts.push(Uint8Array.from([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(csize), u32(offset), u16(0))));
    var total = parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }
  function xmlEsc(s) {
    return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function colName(i) { var s = ""; i++; while (i) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - r - 1) / 26; } return s; }
  function serial(t) { return (Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(1899, 11, 30)) / 86400000; }

  /* Generic one-sheet workbook. cols: [{label, width, type: "d" (date {y,m,d}) | "n" (number) | "s" (text), sum: bool}], rows: arrays of values. */
  function sheetXLSX(cols, rows, sheetName, totalLabel) {
    var n = cols.length, lastCol = colName(n - 1);
    function str(r, c, v, s) { return '<c r="' + colName(c) + r + '" t="inlineStr"' + (s ? ' s="' + s + '"' : "") + "><is><t xml:space=\"preserve\">" + xmlEsc(v == null ? "" : v) + "</t></is></c>"; }
    var out = ['<row r="1">' + cols.map(function (h, c) { return str(1, c, h.label, 1); }).join("") + "</row>"];
    rows.forEach(function (row, i) {
      var r = i + 2;
      out.push('<row r="' + r + '">' + cols.map(function (col, c) {
        var v = row[c];
        if (col.type === "d") return v ? '<c r="' + colName(c) + r + '" s="2"><v>' + serial(v) + "</v></c>" : "";
        if (col.type === "n") return v === null || v === undefined || v === "" ? "" : '<c r="' + colName(c) + r + '" s="3"><v>' + Number(v).toFixed(2) + "</v></c>";
        return v === null || v === undefined || v === "" ? "" : str(r, c, v);
      }).join("") + "</row>");
    });
    var last = rows.length + 1, tr = last + 2, sums = "";
    cols.forEach(function (col, c) { if (col.sum) sums += '<c r="' + colName(c) + tr + '" s="4"><f>SUM(' + colName(c) + "2:" + colName(c) + last + ")</f></c>"; });
    if (sums) {
      var labelCol = 0; cols.forEach(function (col, c) { if (col.sum && !labelCol) labelCol = Math.max(c - 1, 0); });
      out.push('<row r="' + tr + '">' + str(tr, labelCol, totalLabel || "Total", 1) + sums + "</row>");
    }
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      "<cols>" + cols.map(function (col, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (col.width || 14) + '" customWidth="1"/>'; }).join("") + "</cols>" +
      "<sheetData>" + out.join("") + "</sheetData>" + (rows.length ? '<autoFilter ref="A1:' + lastCol + last + '"/>' : "") + "</worksheet>";
    var name = xmlEsc(String(sheetName || "Transactions").replace(/[\[\]:*?\/\\']/g, "").slice(0, 31));
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    return zip([
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets>' + (rows.length ? '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + name + "'!$A$1:$" + lastCol + "$" + last + "</definedName></definedNames>" : "") + "</workbook>" },
      { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
      { name: "xl/styles.xml", data: styles }
    ]);
  }

  function toXLSX(tx, labels, sheetName) {
    var L = labels || ["Date", "Description", "Memo", "Amount", "Type", "Check/Ref", "Category", "Account", "Bank ID"];
    var widths = [12, 38, 38, 14, 10, 12, 18, 16, 22], types = ["d", "s", "s", "n", "s", "s", "s", "s", "s"];
    var cols = L.map(function (l, i) { return { label: l, width: widths[i], type: types[i], sum: i === 3 }; });
    return sheetXLSX(cols, tx.map(function (t) { return [t.date, t.name || t.desc, t.memo, t.amount, t.type, t.ref, t.category, t.account, t.id]; }), sheetName || "Transactions");
  }

  var core = { detectFormat: detectFormat, parse: parse, parseOFX: parseOFX, parseQIF: parseQIF, summarize: summarize,
    toCSV: toCSV, toQuickBooks: toQuickBooks, toXero: toXero, toQIF: toQIF, toOFX: toOFX, toXLSX: toXLSX, sheetXLSX: sheetXLSX,
    crc32: crc32, fmtDate: fmtDate, csvCell: csvCell };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }
  window.LPOFX = core;
  if (!document.getElementById("lpo-file")) return;   // library only (used by the Norma 43 page)

  // ---------- UI ----------
  var ES = document.documentElement.lang === "es";
  var T = ES ? {
    labels: ["Fecha", "Concepto", "Detalle", "Importe", "Tipo", "Cheque/Ref", "Categoría", "Cuenta", "ID del banco"], sheet: "Movimientos",
    notRecognized: "No reconozco el archivo. Debe ser OFX, QFX, QBO (Web Connect) o QIF.", noData: "Elige un archivo o pega su contenido.",
    read: " movimientos leídos", from: " del ", to: " al ", unreadable: "Movimientos sin fecha o importe válidos (omitidos): ",
    moneyIn: "Entradas", moneyOut: "Salidas", account: "Cuenta", closing: "saldo final en el archivo", opening: "saldo inicial que resulta",
    openingHint: "Compáralo con el saldo final del extracto anterior: si no coincide, falta o sobra algún movimiento.",
    dupIds: "El banco repite el mismo ID en estas filas (posibles duplicados): ", repeats: "Filas idénticas en fecha, importe y concepto (revísalas, pueden ser legítimas): ",
    noDup: "Sin IDs duplicados.", preview: "Vista previa (primeras 10 filas)", date: "Fecha", desc: "Concepto", amt: "Importe", qifFmt: "Fechas del QIF leídas como "
  } : {
    labels: ["Date", "Description", "Memo", "Amount", "Type", "Check/Ref", "Category", "Account", "Bank ID"], sheet: "Transactions",
    notRecognized: "This doesn't look like an OFX, QFX, QBO (Web Connect) or QIF file.", noData: "Choose a file or paste its contents.",
    read: " transactions read", from: " from ", to: " to ", unreadable: "Transactions without a valid date or amount (skipped): ",
    moneyIn: "Money in", moneyOut: "Money out", account: "Account", closing: "closing balance in the file", opening: "implied opening balance",
    openingHint: "Compare it with the previous statement's closing balance: if they differ, a transaction is missing or extra.",
    dupIds: "The bank used the same transaction ID on these rows (possible duplicates): ", repeats: "Rows identical in date, amount and description (check them, they can be legitimate): ",
    noDup: "No duplicate IDs.", preview: "Preview (first 10 rows)", date: "Date", desc: "Description", amt: "Amount", qifFmt: "QIF dates read as "
  };
  var $ = function (id) { return document.getElementById(id); };
  var text = "", result = null;
  function money(v) { return v.toLocaleString(ES ? "es-ES" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function load(t) {
    text = t || "";
    result = null;
    $("lpo-setup").classList.add("hidden");
    if (!text.trim()) { $("lpo-msg").textContent = ""; return; }
    var r = core.parse(text, $("lpo-datefmt").value);
    if (!r) { $("lpo-msg").innerHTML = "<span class='text-red-700'>" + T.notRecognized + "</span>"; return; }
    result = r;
    $("lpo-msg").textContent = "";
    $("lpo-qif-wrap").classList.toggle("hidden", r.format !== "qif");
    Array.prototype.forEach.call($("lpo-format").options, function (o) {
      o.disabled = (o.value === "qif" && r.format === "qif") || (o.value === "ofx" && r.format === "ofx");
    });
    if ($("lpo-format").selectedOptions[0].disabled) $("lpo-format").value = "xlsx";
    $("lpo-cur-wrap").classList.toggle("hidden", $("lpo-format").value !== "ofx");
    $("lpo-setup").classList.remove("hidden");
    render();
  }

  function render() {
    var s = core.summarize(result), msg = "<b>" + s.count + "</b>" + T.read;
    if (s.count) msg += T.from + s.first + T.to + s.last;
    if (result.format === "qif") msg += "<br><span class='text-slate-500'>" + T.qifFmt + (result.dateFmt === "dmy" ? (ES ? "DD/MM/AAAA" : "DD/MM/YYYY") : (ES ? "MM/DD/AAAA" : "MM/DD/YYYY")) + "</span>";
    msg += "<br>" + T.moneyIn + ": <span class='text-green-700'>" + money(s.moneyIn) + "</span> · " + T.moneyOut + ": <span class='text-red-700'>" + money(s.moneyOut) + "</span>";
    s.accounts.forEach(function (a) {
      if (a.closing === null) return;
      msg += "<br>" + (a.id ? T.account + " " + esc(a.id.replace(/^.*(.{4})$/, "…$1")) + ": " : "") + T.closing + " <b>" + money(a.closing) + "</b>, " + T.opening + " <b>" + money(a.opening) + "</b>" + (a.currency ? " " + esc(a.currency) : "");
    });
    if (s.accounts.some(function (a) { return a.closing !== null; })) msg += "<br><span class='text-slate-500'>" + T.openingHint + "</span>";
    if (result.unreadable) msg += "<br><span class='text-amber-700'>" + T.unreadable + result.unreadable + "</span>";
    if (s.duplicateIds.length) msg += "<br><span class='text-red-700 font-semibold'>" + T.dupIds + s.duplicateIds.slice(0, 15).join(", ") + "</span>";
    else if (result.format === "ofx" && s.count) msg += "<br><span class='text-green-700'>" + T.noDup + "</span>";
    if (s.repeatedRows.length) msg += "<br><span class='text-amber-700'>" + T.repeats + s.repeatedRows.slice(0, 15).join(", ") + "</span>";
    $("lpo-status").innerHTML = msg;
    $("lpo-preview").innerHTML = "<p class='text-sm text-slate-500 mb-2'>" + T.preview + "</p><table class='w-full text-sm'><tr class='text-left text-slate-500'><th class='pr-3'>#</th><th class='pr-3'>" + T.date + "</th><th class='pr-3'>" + T.desc + "</th><th class='text-right'>" + T.amt + "</th></tr>" +
      result.tx.slice(0, 10).map(function (t, i) {
        return "<tr><td class='pr-3 text-slate-400'>" + (i + 1) + "</td><td class='pr-3 whitespace-nowrap'>" + core.fmtDate(t.date, "iso") + "</td><td class='pr-3'>" + esc(t.desc.slice(0, 60)) +
          "</td><td class='text-right " + (t.amount < 0 ? "text-red-700" : "text-green-700") + "'>" + t.amount.toFixed(2) + "</td></tr>";
      }).join("") + "</table>";
    $("lpo-download").disabled = !s.count;
  }

  function download() {
    if (!result || !result.tx.length) { $("lpo-msg").textContent = T.noData; return; }
    var fmt = $("lpo-format").value, tx = result.tx, content, name, type = "text/csv;charset=utf-8";
    var d = new Date(), now = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var cc = result.accounts.some(function (a) { return a.creditCard; });
    if (fmt === "xlsx") { content = core.toXLSX(tx, T.labels, T.sheet); name = ES ? "movimientos.xlsx" : "transactions.xlsx"; type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
    else if (fmt === "csv") { content = core.toCSV(tx, ",", false, T.labels); name = ES ? "movimientos.csv" : "transactions.csv"; }
    else if (fmt === "csv-eu") { content = core.toCSV(tx, ";", true, T.labels); name = "movimientos.csv"; }
    else if (fmt === "qbo") { content = core.toQuickBooks(tx); name = "quickbooks-online.csv"; }
    else if (fmt === "xero") { content = core.toXero(tx); name = "xero-statement.csv"; }
    else if (fmt === "qif") { content = core.toQIF(tx, cc); name = ES ? "movimientos.qif" : "transactions.qif"; type = "application/qif"; }
    else { content = core.toOFX(tx, $("lpo-currency").value, now); name = ES ? "movimientos.ofx" : "transactions.ofx"; type = "application/x-ofx"; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    $("lpo-after").classList.remove("hidden");
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("lpo-file").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var txt = rd.result;
        if (txt.indexOf("�") > -1) { var r2 = new FileReader(); r2.onload = function () { $("lpo-text").value = r2.result; load(r2.result); }; r2.readAsText(f, "windows-1252"); return; }
        $("lpo-text").value = txt; load(txt);
      };
      rd.readAsText(f, "utf-8");
    });
    $("lpo-text").addEventListener("input", function () { load($("lpo-text").value); });
    $("lpo-datefmt").addEventListener("change", function () { load(text); });
    $("lpo-format").addEventListener("change", function () { $("lpo-cur-wrap").classList.toggle("hidden", $("lpo-format").value !== "ofx"); });
    $("lpo-download").addEventListener("click", download);
    $("lpo-sample").addEventListener("click", function (e) {
      e.preventDefault();
      var s = ES
        ? "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKACCTFROM><BANKID>0000<ACCTID>ES0000001234<ACCTTYPE>CHECKING</BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20260101<DTEND>20260131\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260102<TRNAMT>-45.90<FITID>A1<NAME>PAPELERIA CENTRAL<MEMO>Pago con tarjeta</STMTTRN>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260103<TRNAMT>1250.00<FITID>A2<NAME>TRANSFERENCIA CLIENTE<MEMO>FAC-104</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-12.00<FITID>A3<NAME>COMISION MANTENIMIENTO</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260108<TRNAMT>-800.00<FITID>A4<NAME>ALQUILER ENERO</STMTTRN>\n</BANKTRANLIST><LEDGERBAL><BALAMT>2692.10<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n"
        : "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>000000000<ACCTID>000012345678<ACCTTYPE>CHECKING</BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20260101<DTEND>20260131\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260102<TRNAMT>-45.90<FITID>A1<NAME>OFFICE SUPPLY CO<MEMO>Card purchase</STMTTRN>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260103<TRNAMT>1250.00<FITID>A2<NAME>CLIENT TRANSFER<MEMO>INV-104</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-12.00<FITID>A3<NAME>MONTHLY SERVICE FEE</STMTTRN>\n<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260108<TRNAMT>-800.00<FITID>A4<CHECKNUM>1042<NAME>CHECK 1042</STMTTRN>\n</BANKTRANLIST><LEDGERBAL><BALAMT>2692.10<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n";
      $("lpo-text").value = s; load(s);
    });
  });
})();
