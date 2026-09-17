/**
 * Turn a VFBquery run_query response into the QueryResults the query
 * builder renders, in the client.
 *
 * Port of the two server-side steps a vfbquery query went through:
 * org.geppetto.datasources' VFBqueryResponseProcessor (envelope
 * {headers, rows, count} -> columns ordered by `order`, one row of raw
 * values per entry) and uk.ac.vfb.geppetto's VFBqueryJsonProcessor (API
 * column ids mapped to the v2 column names, cells formatted: class
 * connectivity tables rebuilt in their fixed nine columns, numeric columns
 * space-padded so string sort equals numeric sort, tags re-delimited, pubs
 * flattened, image markdown turned into the serialised Image variable the
 * Images column renders). The output is the same JSON the server put in
 * return_query_results, as a string, so QueriesController's callers see no
 * difference.
 *
 * Pure: takes plain data, returns plain data. Checked against replies
 * captured from the live server by scripts/direct-queries.
 *
 * Java semantics reproduced: numbers parsed by Gson are doubles
 * (Long.toString for whole values, Double.toString otherwise), String.format
 * widths and HALF_UP rounding, replace-all.
 */

var DROPPED_COLUMNS = { source: true, source_id: true };
var COL_ID = 'id';
var COL_UPSTREAM = 'upstream_class';
var COL_DOWNSTREAM = 'downstream_class';
var COL_TOTAL_N = 'total_n';
var COL_CONNECTED_N = 'connected_n';
var COL_PERCENT = 'percent_connected';
var COL_PAIRWISE = 'pairwise_connections';
var COL_TOTAL_WEIGHT = 'total_weight';
var COL_AVG_WEIGHT = 'avg_weight';

var COL_HEADER_MAP = {
  id: 'ID',
  upstream_class: 'Upstream_Class',
  downstream_class: 'Downstream_Class',
  total_n: 'Total_N',
  connected_n: 'Connected_N',
  percent_connected: 'Percent_Connected',
  pairwise_connections: 'Pairwise_Connections',
  total_weight: 'Total_Weight',
  avg_weight: 'Avg_Weight',
  region: 'Region',
  score: 'Score',
  label: 'Name',
  name: 'Name',
  outputs: 'Outputs',
  inputs: 'Inputs',
  presynaptic_terminals: 'Outputs',
  postsynaptic_terminals: 'Inputs',
  tags: 'Gross_Type',
  thumbnail: 'Images',
  pubs: 'Reference',
  publications: 'Reference',
  partner_neuron: 'Name',
  dataset: 'Dataset',
  template: 'Template_Space',
  cell_type: 'Cell_Type',
  cluster: 'Cluster',
  gene: 'Gene',
  level: 'Level',
  extent: 'Extent',
  stage: 'Stage',
  license: 'License',
  technique: 'Imaging_Technique',
  description: 'Definition',
  definition: 'Definition',
  anatomy: 'Expressed_in',
  expression_level: 'Level',
  expression_extent: 'Extent',
  Neurotransmitter: 'Type',
  neurotransmitter: 'Type',
  Weight: 'Weight',
  weight: 'Weight',
  type: 'Type',
  parent: 'Parent',
  expressed_in: 'Expressed_in',
  reference: 'Reference',
  function: 'Function',
  tbars: 'Outputs (Tbars)',
  controls: 'Controls',
  images: 'Images',
  image_count: 'Image_count',
  neuron_A: 'Neuron_A',
  neuron_a: 'Neuron_A',
  neuron_B: 'Partner_Neuron',
  neuron_b: 'Partner_Neuron',
  target: 'Target',
  neuron_label: 'Name',
  neuron_id: 'ID',
  tract_label: 'Name',
  tract_id: 'ID',
  clone_label: 'Name',
  clone_id: 'ID',
  stock_id: 'Stock_ID',
  stock_number: 'Stock_Number',
  genotype: 'Genotype',
  collection: 'Collection',
  fbrf: 'FlyBase_ID',
  title: 'Title',
  year: 'Year',
  miniref: 'Citation',
  pub_type: 'Publication_Type',
  doi: 'DOI',
  pmid: 'PMID',
  pmcid: 'PMCID',
  reference_type: 'Reference_Type'
};

var NUMERIC_COLUMN_MAX_INT_DIGITS = 10;
var NUMERIC_COLUMN_MAX_MAGNITUDE = 1.0e10;

var IMAGE_MARKDOWN = /\[!\[([^\]]*)\]\(([^'"]*?)(?:\s+(['"]).*?\3\s*)?\)\]\(([^)]+)\)/g;
var VFB_THUMBNAIL_URL_TEMPLATE = /^.*?\/i\/[^/]+\/[^/]+\/+([^/]+)\/+thumbnail[^/]*\.(?:png|jpg|jpeg|gif)$/;

function mapHeader (apiId) {
  if (apiId === null || apiId === undefined) {
    return '';
  }
  return Object.prototype.hasOwnProperty.call(COL_HEADER_MAP, apiId) ? COL_HEADER_MAP[apiId] : apiId;
}

function replaceAll (s, a, b) {
  return s.split(a).join(b);
}

function decodeBrackets (text) {
  if (!text || text.indexOf('%') < 0) {
    return text;
  }
  return replaceAll(replaceAll(replaceAll(replaceAll(text, '%5B', '['), '%5b', '['), '%5D', ']'), '%5d', ']');
}

function isTagsColumn (c) {
  return c === 'tags' || c === 'gross_type';
}
function isThumbnailColumn (c) {
  return c === 'thumbnail';
}
function isPubsColumn (c) {
  return c === 'pubs' || c === 'publications';
}

/* Java Double.toString: plain decimal for 1e-3 <= |d| < 1e7, else scientific with at least one fraction digit. */
function javaDoubleToString (d) {
  if (d === 0) {
    return (1 / d < 0) ? '-0.0' : '0.0';
  }
  if (!isFinite(d)) {
    return isNaN(d) ? 'NaN' : (d > 0 ? 'Infinity' : '-Infinity');
  }
  var abs = Math.abs(d);
  if (abs >= 1e-3 && abs < 1e7) {
    var s = String(d);
    if (s.indexOf('e') >= 0) {
      s = d.toFixed(20).replace(/0+$/, '');
    }
    if (s.indexOf('.') < 0) {
      s += '.0';
    }
    return s;
  }
  var exp = d.toExponential();
  var parts = exp.split('e');
  var mant = parts[0];
  if (mant.indexOf('.') < 0) {
    mant += '.0';
  }
  var e = parseInt(parts[1], 10);
  return mant + 'E' + e;
}

/* Object.toString for a value Gson parsed from JSON: doubles print as Java doubles. */
function javaToString (v) {
  if (typeof v === 'number') {
    return javaDoubleToString(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (Array.isArray(v)) {
    return '[' + v.map(javaToString).join(', ') + ']';
  }
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).map(function (k) {
      return k + '=' + javaToString(v[k]);
    }).join(', ') + '}';
  }
  return String(v);
}

function isWhole (d) {
  return d === Math.floor(d) && isFinite(d);
}

/* Long.toString((long) d): truncation toward zero, as a plain integer string. */
function javaLongString (d) {
  var t = d < 0 ? Math.ceil(d) : Math.floor(d);
  return String(t);
}

function bareNumberString (d) {
  if (isWhole(d)) {
    return javaLongString(d);
  }
  return javaDoubleToString(d);
}

function parseNumericCell (v) {
  if (typeof v === 'number') {
    return isFinite(v) ? v : null;
  }
  var s = javaToString(v).trim();
  if (s.length === 0) {
    return null;
  }
  for (var k = 0; k < s.length; k++) {
    var c = s.charAt(k);
    if (!(/[0-9]/.test(c) || c === '.' || c === '-' || c === '+' || c === 'e' || c === 'E')) {
      return null;
    }
  }
  var d = Number(s);
  return isFinite(d) && s !== '' && !isNaN(d) ? d : null;
}

function repeatSpace (n) {
  var s = '';
  for (var k = 0; k < n; k++) {
    s += ' ';
  }
  return s;
}

function padNumericCell (v, intWidth, fracWidth) {
  var totalWidth = intWidth + (fracWidth > 0 ? 1 + fracWidth : 0);
  if (v === null || v === undefined) {
    return repeatSpace(totalWidth);
  }
  var d = parseNumericCell(v);
  if (d === null) {
    return javaToString(v);
  }
  var s = bareNumberString(d);
  var dot = s.indexOf('.');
  var iw = dot < 0 ? s.length : dot;
  if (s.length > 0 && s.charAt(0) === '-') {
    iw -= 1;
  }
  var fw = dot < 0 ? 0 : s.length - dot - 1;
  var sb = repeatSpace(intWidth - iw) + s;
  if (fracWidth > 0) {
    sb += repeatSpace(dot < 0 ? 1 + fracWidth : fracWidth - fw);
  }
  return sb;
}

/* String.format("%<width>d") */
function formatIntWidth (ln, width) {
  var s = String(ln);
  return repeatSpace(width - s.length) + s;
}

/*
 * java.util.Formatter's %.Nf: HALF_UP rounding applied to the shortest
 * decimal representation of the double (so 1.45 -> "1.5", where toFixed,
 * which works on the exact binary value 1.4499..., gives "1.4").
 */
function toFixedHalfUp (d, precision) {
  var neg = d < 0;
  var abs = Math.abs(d);
  var s = String(abs);
  if (s.indexOf('e') >= 0) {
    s = abs.toFixed(20);
  }
  var dot = s.indexOf('.');
  var intPart = dot < 0 ? s : s.substring(0, dot);
  var frac = dot < 0 ? '' : s.substring(dot + 1);
  while (frac.length < precision + 1) {
    frac += '0';
  }
  var digits = (intPart + frac.substring(0, precision)).split('');
  var carry = frac.charAt(precision) >= '5' ? 1 : 0;
  for (var i = digits.length - 1; i >= 0 && carry > 0; i--) {
    var v = parseInt(digits[i], 10) + carry;
    digits[i] = String(v % 10);
    carry = v >= 10 ? 1 : 0;
  }
  if (carry > 0) {
    digits.unshift('1');
  }
  var all = digits.join('');
  var out = precision > 0 ? all.substring(0, all.length - precision) + '.' + all.substring(all.length - precision) : all;
  return (neg ? '-' : '') + out;
}

function formatPercentValue (d) {
  var s = toFixedHalfUp(d, 1) + '%';
  return repeatSpace(6 - s.length) + s;
}

function formatFloatWidth (d, width, precision) {
  var s = toFixedHalfUp(d, precision);
  return repeatSpace(width - s.length) + s;
}

function formatPubsList (pubs) {
  var sb = '';
  for (var i = 0; i < pubs.length; i++) {
    var e = pubs[i];
    if (e === null || e === undefined) {
      continue;
    }
    var formatted = null;
    if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
      var core = e.core;
      if (core !== null && typeof core === 'object' && !Array.isArray(core)) {
        var label = core.label !== null && core.label !== undefined ? javaToString(core.label).trim() : '';
        if (label.length > 0) {
          formatted = label;
        } else {
          var symbol = core.symbol !== null && core.symbol !== undefined ? javaToString(core.symbol).trim() : '';
          if (symbol.length > 0) {
            formatted = symbol;
          }
        }
      }
    }
    if (formatted === null) {
      formatted = javaToString(e);
    }
    if (sb.length > 0) {
      sb += '; ';
    }
    sb += formatted;
  }
  return sb;
}

function wrapPlainUrlAsImageMarkdown (url, imageId) {
  var ref = imageId === null || imageId === undefined ? '' : imageId;
  var m = VFB_THUMBNAIL_URL_TEMPLATE.exec(url);
  if (m && m[1]) {
    ref = m[1] + (imageId ? ',' + imageId : '');
  }
  return '[![](' + url + ')](' + ref + ')';
}

/**
 * The serialised `images` Variable the Images column renders: an ArrayValue
 * of one Image per markdown item, exactly as GeppettoSerializer wrote it.
 * imageTypeRef is the Image type's reference in the model, e.g.
 * 'geppettoModel#//@libraries.5/@types.10'.
 */
function imageMarkdownToVariableJson (s, imageTypeRef) {
  if (!imageTypeRef) {
    return null;
  }
  var elements = [];
  var anyMatch = false;
  var re = new RegExp(IMAGE_MARKDOWN.source, 'g');
  var m;
  while ((m = re.exec(s)) !== null) {
    anyMatch = true;
    var alt = decodeBrackets(m[1]);
    var url = m[2];
    var ref = m[4];
    if (url === null || url === undefined || url.trim().length === 0) {
      continue;
    }
    /*
     * A row's thumbnail markdown references the plain image id, the same id for
     * every template the image is aligned to -- so a carousel of alignments gave
     * every slide the same reference and clicking the VNC (or any non-first)
     * slide loaded the first alignment instead. The template is in the
     * thumbnail's URL, so carry it in the reference, matching the
     * "<template>,<image>" form a plain-URL thumbnail already produces and that
     * the carousel ordering and the frontend's loader both read.
     */
    if (ref.indexOf(',') < 0) {
      var tm = VFB_THUMBNAIL_URL_TEMPLATE.exec(url.trim());
      if (tm && tm[1] && tm[1] !== ref) {
        ref = tm[1] + ',' + ref;
      }
    }
    elements.push({
      eClass: 'ArrayElement',
      index: elements.length,
      initialValue: { eClass: 'Image', data: replaceAll(url.trim(), 'http://', 'https://'), name: alt === null || alt === undefined ? '' : alt, reference: ref, format: 'PNG' }
    });
  }
  if (!anyMatch) {
    return null;
  }
  if (elements.length === 0) {
    return '';
  }
  return JSON.stringify({
    eClass: 'Variable',
    id: 'images',
    name: 'Images',
    static: false,
    types: [{ $ref: imageTypeRef }],
    initialValues: [{ key: imageTypeRef, value: { eClass: 'ArrayValue', elements: elements } }]
  });
}

function formatGenericCell (apiCol, v, imageTypeRef) {
  if (v === null || v === undefined) {
    return '';
  }
  if (isTagsColumn(apiCol)) {
    if (Array.isArray(v)) {
      return v.filter(function (e) {
        return e !== null && e !== undefined;
      }).map(javaToString).join('; ');
    }
    return replaceAll(javaToString(v), '|', '; ');
  }
  if (isPubsColumn(apiCol) && Array.isArray(v)) {
    return formatPubsList(v);
  }
  if (Array.isArray(v)) {
    return v.filter(function (e) {
      return e !== null && e !== undefined;
    }).map(javaToString).join('|');
  }
  if (typeof v === 'number') {
    if (isWhole(v)) {
      return javaLongString(v);
    }
    return javaDoubleToString(v);
  }
  var s = javaToString(v);
  if (s.length > 2 && s.charAt(0) === '[' && s.charAt(1) === '!') {
    var json = imageMarkdownToVariableJson(s, imageTypeRef);
    if (json !== null) {
      return json;
    }
    return '';
  }
  return s;
}

/**
 * VFBqueryResponseProcessor: envelope -> {header: [api column ids ordered by
 * `order`], rows: [[raw values...]]}. A malformed envelope gives no columns
 * and no rows.
 */
export function responseToColumns (response) {
  var out = { header: [], rows: [] };
  if (!response || typeof response !== 'object' || !Object.prototype.hasOwnProperty.call(response, 'headers') || !Object.prototype.hasOwnProperty.call(response, 'rows')) {
    return out;
  }
  var headers = response.headers || {};
  var keys = Object.keys(headers);
  var orderOf = function (k) {
    var o = headers[k] && headers[k].order;
    return typeof o === 'number' ? Math.trunc(o) : 2147483647;
  };
  // stable sort by order
  var indexed = keys.map(function (k, i) {
    return { k: k, i: i, o: orderOf(k) };
  });
  indexed.sort(function (a, b) {
    return a.o !== b.o ? a.o - b.o : a.i - b.i;
  });
  out.header = indexed.map(function (x) {
    return x.k;
  });
  var rows = Array.isArray(response.rows) ? response.rows : [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r] || {};
    out.rows.push(out.header.map(function (col) {
      return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null;
    }));
  }
  return out;
}

function cell (columns, col, rowIdx) {
  var ci = columns.header.indexOf(col);
  if (ci < 0) {
    return null;
  }
  var v = columns.rows[rowIdx][ci];
  return v === undefined ? null : v;
}

function stringValue (columns, col, rowIdx) {
  var v = cell(columns, col, rowIdx);
  return v === null ? '' : javaToString(v);
}

function numberOf (v) {
  if (typeof v === 'number') {
    return v;
  }
  var d = Number(javaToString(v));
  return isNaN(d) ? null : d;
}

function formatInt (columns, col, rowIdx, width) {
  var v = cell(columns, col, rowIdx);
  if (v === null) {
    return '';
  }
  var d = numberOf(v);
  if (d === null) {
    return javaToString(v);
  }
  return formatIntWidth(javaLongString(d), width);
}

function formatPercent (columns, col, rowIdx) {
  var v = cell(columns, col, rowIdx);
  if (v === null) {
    return '';
  }
  var d = numberOf(v);
  return d === null ? javaToString(v) : formatPercentValue(d);
}

function formatFloat (columns, col, rowIdx, width, precision) {
  var v = cell(columns, col, rowIdx);
  if (v === null) {
    return '';
  }
  var d = numberOf(v);
  return d === null ? javaToString(v) : formatFloatWidth(d, width, precision);
}

function buildClassConnectivityRows (columns, queriedId, queriedName, hasUpstream, hasDownstream) {
  var header = ['ID', 'Upstream_Class', 'Downstream_Class', 'Total_N', 'Connected_N', 'Percent_Connected', 'Pairwise_Connections', 'Total_Weight', 'Avg_Weight'];
  var qid = queriedId || '';
  var qlabel = queriedName ? queriedName : qid;
  var queriedMarkdown = qid ? '[' + qlabel + '](' + qid + ')' : qlabel;
  var results = [];
  for (var i = 0; i < columns.rows.length; i++) {
    results.push({
      eClass: 'SerializableQueryResult',
      values: [
        stringValue(columns, COL_ID, i),
        hasUpstream ? stringValue(columns, COL_UPSTREAM, i) : queriedMarkdown,
        hasDownstream ? stringValue(columns, COL_DOWNSTREAM, i) : queriedMarkdown,
        formatInt(columns, COL_TOTAL_N, i, 6),
        formatInt(columns, COL_CONNECTED_N, i, 6),
        formatPercent(columns, COL_PERCENT, i),
        formatInt(columns, COL_PAIRWISE, i, 8),
        formatInt(columns, COL_TOTAL_WEIGHT, i, 9),
        formatFloat(columns, COL_AVG_WEIGHT, i, 7, 1)
      ]
    });
  }
  return { eClass: 'QueryResults', header: header, results: results };
}

function analyseNumericColumns (columns) {
  var n = columns.rows.length;
  var info = [];
  for (var ci = 0; ci < columns.header.length; ci++) {
    var col = columns.header[ci];
    if (isTagsColumn(col) || isPubsColumn(col) || isThumbnailColumn(col)) {
      info.push({ numeric: false, intWidth: 0, fracWidth: 0 });
      continue;
    }
    var numeric = true;
    var seenAny = false;
    var maxInt = 0;
    var maxFrac = 0;
    for (var i = 0; i < n; i++) {
      var v = columns.rows[i][ci];
      if (v === null || v === undefined) {
        continue;
      }
      var d = parseNumericCell(v);
      if (d === null || Math.abs(d) > NUMERIC_COLUMN_MAX_MAGNITUDE) {
        numeric = false;
        break;
      }
      seenAny = true;
      var s = bareNumberString(d);
      var dot = s.indexOf('.');
      var iw = dot < 0 ? s.length : dot;
      var fw = dot < 0 ? 0 : s.length - dot - 1;
      if (s.length > 0 && s.charAt(0) === '-') {
        iw -= 1;
      }
      if (iw > maxInt) {
        maxInt = iw;
      }
      if (fw > maxFrac) {
        maxFrac = fw;
      }
      if (maxInt > NUMERIC_COLUMN_MAX_INT_DIGITS) {
        numeric = false;
        break;
      }
    }
    info.push({ numeric: numeric && seenAny, intWidth: maxInt, fracWidth: maxFrac });
  }
  return info;
}

function buildGenericRows (columns, imageTypeRef) {
  var header = [];
  var used = {};
  for (var h = 0; h < columns.header.length; h++) {
    var col = columns.header[h];
    if (DROPPED_COLUMNS[col]) {
      continue;
    }
    var mapped = mapHeader(col);
    if (used[mapped]) {
      mapped = col;
      for (var dup = 2; used[mapped]; dup++) {
        mapped = col + '_' + dup;
      }
    }
    used[mapped] = true;
    header.push(mapped);
  }
  var info = analyseNumericColumns(columns);
  var results = [];
  for (var i = 0; i < columns.rows.length; i++) {
    var values = [];
    for (var ci = 0; ci < columns.header.length; ci++) {
      var c = columns.header[ci];
      if (DROPPED_COLUMNS[c]) {
        continue;
      }
      var v = columns.rows[i][ci];
      if (v === undefined) {
        v = null;
      }
      if (isThumbnailColumn(c) && typeof v === 'string') {
        if (v.length > 0 && v.charAt(0) !== '[' && (v.indexOf('http://') === 0 || v.indexOf('https://') === 0)) {
          var idObj = cell(columns, COL_ID, i);
          v = wrapPlainUrlAsImageMarkdown(v, idObj !== null ? javaToString(idObj) : '');
        }
      }
      if (info[ci].numeric) {
        values.push(padNumericCell(v, info[ci].intWidth, info[ci].fracWidth));
      } else {
        values.push(formatGenericCell(c, v, imageTypeRef));
      }
    }
    results.push({ eClass: 'SerializableQueryResult', values: values });
  }
  return { eClass: 'QueryResults', header: header, results: results };
}

/**
 * The port of VFBqueryJsonProcessor.process(): run_query JSON in, the
 * QueryResults object the server serialised out.
 *
 * @param response - the parsed run_query JSON
 * @param queried - {id, name} of the term the query ran on
 * @param imageTypeRef - reference to the Image type, e.g. 'geppettoModel#//@libraries.5/@types.10'
 */
export function responseToQueryResults (response, queried, imageTypeRef) {
  var built = buildQueryResults(response, queried, imageTypeRef);
  /*
   * The server's serialiser leaves out empty lists, so an empty table came
   * back as {"eClass":"QueryResults"} with no header or results; keep that
   * shape so the callers see exactly what they used to.
   */
  var out = { eClass: 'QueryResults' };
  if (built.header.length > 0) {
    out.header = built.header;
  }
  if (built.results.length > 0) {
    out.results = built.results;
  }
  return out;
}

function buildQueryResults (response, queried, imageTypeRef) {
  var columns = responseToColumns(response);
  var hasUpstream = columns.header.indexOf(COL_UPSTREAM) >= 0;
  var hasDownstream = columns.header.indexOf(COL_DOWNSTREAM) >= 0;
  var isClassConnectivity = (hasUpstream || hasDownstream)
    && columns.header.indexOf(COL_TOTAL_N) >= 0
    && columns.header.indexOf(COL_CONNECTED_N) >= 0
    && columns.header.indexOf(COL_PERCENT) >= 0
    && columns.header.indexOf(COL_PAIRWISE) >= 0;
  if (isClassConnectivity) {
    return buildClassConnectivityRows(columns, queried ? queried.id : '', queried ? queried.name : null, hasUpstream, hasDownstream);
  }
  return buildGenericRows(columns, imageTypeRef);
}

/**
 * The count a run_query_count returned: the number of rows in the count
 * query's response (the processing step is skipped for counts).
 */
export function responseToCount (response) {
  return responseToColumns(response).rows.length;
}

/**
 * Combine several queries' results as the server did for a compound run:
 * AND on the ID column, in the order given. A single result passes through.
 */
export function combineResults (list) {
  if (list.length === 1) {
    return list[0];
  }
  var final = { eClass: 'QueryResults', header: [], results: [] };
  var finalIds = [];
  var idsOf = function (r) {
    var at = r.header.indexOf('ID');
    return at < 0 ? [] : r.results.map(function (row) {
      return row.values[at];
    });
  };
  for (var i = 0; i < list.length; i++) {
    var r = { header: list[i].header || [], results: list[i].results || [] };
    if (final.header.length === 0) {
      final.header = r.header.slice();
    }
    /*
     * The server refused a compound run whose parts came back with different
     * headers ("...incompatible headers"), which is most compound queries of
     * two different types -- e.g. SimilarMorphologyTo (id, score, name, ...)
     * AND epFrag (id, label, ...). Throwing here only handed the run to a
     * server that fails the same way, leaving the user an error dialog and no
     * results at all. The rows shown are the FIRST query's either way, so keep
     * its header and rows and use the other queries solely to intersect on ID,
     * which is what the loop below does.
     */
    var ids = idsOf(r);
    if (i === 0) {
      final.results = r.results.slice(0, ids.length);
      finalIds = ids.slice();
    }
    var keepIds = {};
    for (var k = 0; k < ids.length; k++) {
      keepIds[ids[k]] = true;
    }
    var kept = [];
    var keptIds = [];
    for (var f = 0; f < finalIds.length; f++) {
      if (keepIds[finalIds[f]]) {
        kept.push(final.results[f]);
        keptIds.push(finalIds[f]);
      }
    }
    final.results = kept;
    finalIds = keptIds;
  }
  var out = { eClass: 'QueryResults' };
  if (final.header.length > 0) {
    out.header = final.header;
  }
  if (final.results.length > 0) {
    out.results = final.results;
  }
  return out;
}
