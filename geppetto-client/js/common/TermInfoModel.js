/**
 * Build the Geppetto model for a VFB term from its VFBquery term info, in
 * the client.
 *
 * This is a port of uk.ac.vfb.geppetto's VFBProcessTermInfoVFBqueryJson,
 * the server-side query processor that turned v3-cached/get_term_info JSON
 * into the variable_fetched reply: a Variable for the term whose anonymous
 * CompositeType carries the term's super types (SimpleTypes in the ontology
 * library, created on demand), a `<id>_meta` variable whose `<id>_metadata`
 * CompositeType holds the Term Info rows as HTML/Image/Text values, and
 * `<id>_obj` / `<id>_swc` ImportTypes and a `<id>_slices` Image value for
 * the viewers. The output is the same raw GeppettoModel JSON the server
 * sent, with every reference computed against the CLIENT model, so it can
 * be handed to Manager.addVariableToModel unchanged.
 *
 * Everything here is pure: termInfoToRawModel takes the term info and a
 * description of the client model (library ids, names and type ids) and
 * returns the raw model plus the ids of the types it created, so the same
 * function can be checked in node against replies captured from the live
 * server (scripts/direct-terminfo).
 *
 * Java semantics that matter and are reproduced: String.replace replaces
 * every occurrence; Double.toString prints integral values with ".0";
 * getAsInt / intValue truncate; the first type with a given id wins in
 * getOrCreateSimpleType; JsonObject entries iterate in insertion order.
 */

var AVAILABLE_TEMPLATES = [
  'VFB_00017894', 'VFB_00101567', 'VFB_00101384', 'VFB_00050000',
  'VFB_00049000', 'VFB_00100000', 'VFB_00030786', 'VFB_00200000'
];
var TEMPLATE_NAMES = {
  VFB_00017894: 'JFRC2',
  VFB_00101567: 'JRC2018U',
  VFB_00101384: 'JRCFIB2018Fum',
  VFB_00050000: 'L1 larval CNS ssTEM',
  VFB_00049000: 'L3 CNS template - Wood2018',
  VFB_00100000: 'COURT2018VNS',
  VFB_00030786: 'adult brain template Ito2014',
  VFB_00200000: 'JRCVNC2018U'
};
var DISPLAY_ORIENTATION = {
  VFB_00101567: 'LIP',
  VFB_00017894: 'LIP',
  VFB_00030786: 'LIP',
  VFB_00101384: 'LAI',
  VFB_00049000: 'RPI'
};

var MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
var CONF_PREFIX = /^(\d+%)\s+([\s\S]*)$/;
var TRAILING_REF = /^([\s\S]*?)\s*\(((?:\[[^\]]+\]\([^)]+\)(?:,\s*)?)+)\)\s*$/;

function replaceAll (s, a, b) {
  return s.split(a).join(b);
}

function decodeBrackets (text) {
  if (!text || text.indexOf('%') < 0) {
    return text;
  }
  return replaceAll(replaceAll(replaceAll(replaceAll(text, '%5B', '['), '%5b', '['), '%5D', ']'), '%5d', ']');
}

function referenceIcon (ref) {
  if (ref === null || ref === undefined) {
    return '';
  }
  var low = ref.toLowerCase();
  if (low.indexOf('doi:') === 0) {
    return '<i class="popup-icon-link gpt-doi"></i>';
  }
  if (low.indexOf('flybase:') === 0) {
    return '<i class="popup-icon-link gpt-fly"></i>';
  }
  if (low.indexOf('pmid:') === 0 || low.indexOf('pubmed:') === 0) {
    return '<i class="popup-icon-link gpt-pubmed"></i>';
  }
  if (low.indexOf('go_ref:') === 0) {
    return '<i class="popup-icon-link gpt-geneontology"></i>';
  }
  return '';
}

export function mdToHtml (text) {
  if (!text) {
    return '';
  }
  return text.replace(MD_LINK, function (m, rawLabel, target) {
    var label = decodeBrackets(rawLabel);
    if (target.indexOf('http://') === 0 || target.indexOf('https://') === 0) {
      var icon = referenceIcon(label);
      var inner = icon === '' ? label : icon;
      return '<a href="' + target + '" target="_blank" title="' + label + '">' + inner + '</a>';
    }
    var sf = target.indexOf(',') >= 0 ? target.substring(target.lastIndexOf(',') + 1) : target;
    return '<a href="?id=' + sf + '" data-instancepath="' + sf + '">' + label + '</a>';
  });
}

function confidenceBadge (pct) {
  return '<a href="https://virtualflybrain.org/docs/concepts/confidence-value/"'
    + ' target="_blank" title="confidence value">'
    + '<span class="badge badge-secondary" title="confidence value">' + pct + '</span></a>';
}

function stripLinks (md) {
  if (!md) {
    return '';
  }
  return md.replace(MD_LINK, function (m, label) {
    return decodeBrackets(label);
  });
}

function symbolText (md) {
  if (!md) {
    return '';
  }
  var m = new RegExp(MD_LINK.source).exec(md);
  return decodeBrackets(m ? m[1] : md);
}

export function relationshipsToHtml (metaValue) {
  if (!metaValue) {
    return '';
  }
  var sb = '<ul class="terminfo-relationships">';
  var segs = metaValue.split(';');
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i].trim();
    if (seg === '') {
      continue;
    }
    var badge = '';
    var cm = CONF_PREFIX.exec(seg);
    if (cm) {
      badge = confidenceBadge(cm[1]);
      seg = cm[2].trim();
    }
    var refs = '';
    var rm = TRAILING_REF.exec(seg);
    if (rm) {
      refs = mdToHtml(rm[2]);
      seg = rm[1].trim();
    }
    var body;
    var colon = seg.indexOf(':');
    if (colon > 0) {
      body = stripLinks(seg.substring(0, colon).trim()) + ': ' + mdToHtml(seg.substring(colon + 1).trim());
    } else {
      body = mdToHtml(seg);
    }
    sb += '<li>';
    if (badge !== '') {
      sb += badge + ' ';
    }
    if (refs !== '') {
      sb += refs + ' ';
    }
    sb += body + '</li>';
  }
  return sb + '</ul>';
}

function metaListToHtml (metaValue, css) {
  if (!metaValue) {
    return '';
  }
  var sb = '<ul class="terminfo-' + css + '">';
  var segs = metaValue.split(';');
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i].trim();
    if (seg !== '') {
      sb += '<li>' + mdToHtml(seg) + '</li>';
    }
  }
  return sb + '</ul>';
}

function secureUrl (url) {
  return url === null || url === undefined ? '' : replaceAll(url, 'http://', 'https://');
}

export function formatCount (n) {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1000000) {
    return Math.floor(n / 1000) + 'k';
  }
  if (n < 1000000000) {
    return Math.floor(n / 1000000) + 'M';
  }
  return Math.floor(n / 1000000000) + 'B';
}

/* Java Double.toString for the values that occur here (voxel sizes). */
function javaDouble (d) {
  if (d === null || d === undefined) {
    return 'null';
  }
  var s = String(d);
  if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0 && s !== 'NaN' && s !== 'Infinity' && s !== '-Infinity') {
    s += '.0';
  }
  return s;
}

/* Java (long) / getAsInt truncation toward zero. */
function javaInt (d) {
  return d < 0 ? Math.ceil(d) : Math.floor(d);
}

function optStr (o, key) {
  if (o && Object.prototype.hasOwnProperty.call(o, key) && o[key] !== null && o[key] !== undefined && typeof o[key] !== 'object') {
    return String(o[key]);
  }
  return '';
}

function strList (o, key) {
  var out = [];
  if (o && Array.isArray(o[key])) {
    for (var i = 0; i < o[key].length; i++) {
      var e = o[key][i];
      if (e !== null && typeof e !== 'object') {
        out.push(String(e));
      }
    }
  }
  return out;
}

function isObj (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lastId (iri) {
  if (iri === null || iri === undefined) {
    return '';
  }
  var slash = iri.lastIndexOf('/');
  return slash >= 0 ? iri.substring(slash + 1) : iri;
}

function typesString (tags) {
  var result = '';
  if (tags) {
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (!t) {
        continue;
      }
      result = '<span class="label label-' + t + '">' + replaceAll(t, '_', ' ') + '</span> ' + result;
    }
  }
  return '<span class="label types">' + result + '</span>';
}

/*
 * Stray backslash-before-quote artefacts are stripped from every string, as
 * the server's parseAndRepairTermInfo does. 
 */
function sanitize (el) {
  if (el === null || typeof el !== 'object') {
    if (typeof el === 'string' && el.indexOf('\\') >= 0) {
      return el.replace(/\\(['"])/g, '$1');
    }
    return el;
  }
  if (Array.isArray(el)) {
    return el.map(sanitize);
  }
  var out = {};
  var keys = Object.keys(el);
  for (var i = 0; i < keys.length; i++) {
    out[keys[i]] = sanitize(el[keys[i]]);
  }
  return out;
}

function synonymsHtml (ti) {
  if (!Array.isArray(ti.Synonyms)) {
    return '';
  }
  var sb = '<ul class="terminfo-synonyms">';
  var any = false;
  for (var i = 0; i < ti.Synonyms.length; i++) {
    var s = ti.Synonyms[i];
    if (!s || !s.label) {
      continue;
    }
    var scope = s.scope === null || s.scope === undefined ? '' : replaceAll(replaceAll(s.scope, 'has_', ''), '_', ' ').trim();
    var line = s.label;
    if (scope !== '' && scope.toLowerCase() !== 'exact') {
      line = scope + ': ' + s.label;
    }
    if (s.publication) {
      line += ' (' + mdToHtml(s.publication) + ')';
    }
    sb += '<li>' + line + '</li>';
    any = true;
  }
  return any ? sb + '</ul>' : '';
}

function xrefsHtml (ti) {
  if (!Array.isArray(ti.Xrefs)) {
    return '';
  }
  var sb = '';
  for (var i = 0; i < ti.Xrefs.length; i++) {
    var x = ti.Xrefs[i];
    if (!x || !x.link) {
      continue;
    }
    var label = x.label === null || x.label === undefined ? '' : x.label;
    var icon = x.icon ? '<img class="terminfo-siteicon" src="' + secureUrl(x.icon) + '"/> ' : '';
    if (sb !== '') {
      sb += '<br/>';
    }
    sb += '<a href="' + x.link + '" target="_blank" title="' + label + '">' + icon + label + '</a>';
  }
  return sb;
}

function pubList (ti) {
  return Array.isArray(ti.Publications) ? ti.Publications : [];
}

function licenseList (ti) {
  var out = [];
  if (isObj(ti.Licenses)) {
    var keys = Object.keys(ti.Licenses);
    for (var i = 0; i < keys.length; i++) {
      out.push(ti.Licenses[keys[i]]);
    }
  }
  return out;
}

function referencesHtml (ti, pubs) {
  var order = [];
  var byId = {};
  var put = function (key, value) {
    if (!Object.prototype.hasOwnProperty.call(byId, key)) {
      order.push(key);
    }
    byId[key] = value;
  };
  for (var i = 0; i < pubs.length; i++) {
    var p = pubs[i];
    if (!p) {
      continue;
    }
    var mref = p.microref ? mdToHtml(p.microref) : (p.short_form !== null && p.short_form !== undefined ? p.short_form : '');
    if (mref === '') {
      continue;
    }
    var icons = '';
    if (Array.isArray(p.refs)) {
      for (var j = 0; j < p.refs.length; j++) {
        var r = p.refs[j];
        var cls = r.indexOf('pubmed') >= 0 ? 'gpt-pubmed' : r.indexOf('doi.org') >= 0 ? 'gpt-doi'
          : r.indexOf('flybase') >= 0 ? 'gpt-fly' : 'fa-external-link';
        icons += ' <a href="' + r + '" target="_blank"><i class="popup-icon-link ' + cls + '"></i></a>';
      }
    }
    put(p.short_form ? p.short_form : mref, mref + icons);
  }
  var mds = [];
  if (Array.isArray(ti.Synonyms)) {
    for (var k = 0; k < ti.Synonyms.length; k++) {
      var s = ti.Synonyms[k];
      if (isObj(s) && s.publication !== null && s.publication !== undefined) {
        mds.push(String(s.publication));
      }
    }
  }
  if (isObj(ti.Meta) && ti.Meta.Description !== null && ti.Meta.Description !== undefined) {
    mds.push(String(ti.Meta.Description));
  }
  for (var m = 0; m < mds.length; m++) {
    var re = new RegExp(MD_LINK.source, 'g');
    var match;
    while ((match = re.exec(mds[m])) !== null) {
      var id = match[2];
      if (!id || Object.prototype.hasOwnProperty.call(byId, id)) {
        continue;
      }
      put(id, '<a href="?id=' + id + '" data-instancepath="' + id + '">' + decodeBrackets(match[1]) + '</a>');
    }
  }
  if (order.length === 0) {
    return '';
  }
  var sb = '<ul class="terminfo-references">';
  for (var n = 0; n < order.length; n++) {
    sb += '<li>' + byId[order[n]] + '</li>';
  }
  return sb + '</ul>';
}

function displayOrientation (templateId, kbOrientation) {
  if (templateId && Object.prototype.hasOwnProperty.call(DISPLAY_ORIENTATION, templateId)) {
    return DISPLAY_ORIENTATION[templateId];
  }
  if (kbOrientation && kbOrientation.trim().length === 3) {
    return kbOrientation.trim().toUpperCase();
  }
  return null;
}

function firstImage (ti) {
  if (isObj(ti.Images)) {
    var keys = Object.keys(ti.Images);
    for (var i = 0; i < keys.length; i++) {
      var arr = ti.Images[keys[i]];
      if (Array.isArray(arr) && arr.length > 0) {
        return { template: keys[i], rec: arr[0] };
      }
    }
  }
  return null;
}

function orientationFromImages (ti) {
  var f = firstImage(ti);
  return f && f.rec ? displayOrientation(f.template, f.rec.orientation) : null;
}

function centreString (c) {
  return '[' + javaInt(c.X) + ', ' + javaInt(c.Y) + ', ' + javaInt(c.Z) + ']';
}

export function buildDomains (ti) {
  var domains = [];
  var isTemplate = ti.IsTemplate === true;
  if (isTemplate && isObj(ti.Domains) && Object.keys(ti.Domains).length > 0) {
    var domainId = new Array(600).fill(null);
    var domainName = new Array(600).fill(null);
    var domainType = new Array(600).fill(null);
    var domainCentre = new Array(600).fill(null);
    var voxelSize = [null, null, null, null];
    var f = firstImage(ti);
    if (f && f.rec) {
      var self = f.rec;
      if (isObj(self.voxel)) {
        voxelSize[0] = javaDouble(self.voxel.X);
        voxelSize[1] = javaDouble(self.voxel.Y);
        voxelSize[2] = javaDouble(self.voxel.Z);
      }
      voxelSize[3] = displayOrientation(f.template, self.orientation);
      if (isObj(self.center) && self.center.X !== null && self.center.X !== undefined
          && self.center.Y !== null && self.center.Y !== undefined && self.center.Z !== null && self.center.Z !== undefined) {
        domainCentre[0] = centreString(self.center);
      }
    }
    var keys = Object.keys(ti.Domains);
    for (var k = 0; k < keys.length; k++) {
      var i = parseInt(keys[k], 10);
      if (isNaN(i) || String(i) !== keys[k] || i < 0 || i >= 600 || !isObj(ti.Domains[keys[k]])) {
        continue;
      }
      var d = ti.Domains[keys[k]];
      domainId[i] = d.id !== null && d.id !== undefined ? String(d.id) : null;
      domainName[i] = d.type_label !== null && d.type_label !== undefined ? String(d.type_label) : null;
      domainType[i] = d.type_id !== null && d.type_id !== undefined ? String(d.type_id) : null;
      if (isObj(d.center)) {
        var c = d.center;
        if (Object.prototype.hasOwnProperty.call(c, 'X') && Object.prototype.hasOwnProperty.call(c, 'Y')
            && Object.prototype.hasOwnProperty.call(c, 'Z') && c.Z !== null) {
          domainCentre[i] = centreString(c);
        }
      }
    }
    domains.push(voxelSize, domainId, domainName, domainType, domainCentre);
  } else {
    var sf = optStr(ti, 'Id');
    var label = optStr(ti, 'Name');
    if (label === '') {
      label = sf;
    }
    domains.push(['0.622088', '0.622088', '0.622088', orientationFromImages(ti)], [sf], [label], [sf], ['[511, 255, 108]']);
  }
  return domains;
}

/**
 * Tracks the client model while a term is being built: which types exist
 * in which library, so references can be computed and new SimpleTypes
 * appended exactly as the server's GeppettoModelAccess did.
 *
 * shape: {id, name, libraries: [{id, name, types: [typeId...]}],
 *         variableCount, dataSourceCount, queryCount}
 */
function ModelView (shape) {
  this.shape = shape;
  this.created = {}; // libraryId -> [rawType]
  this.libIndex = {};
  for (var i = 0; i < shape.libraries.length; i++) {
    this.libIndex[shape.libraries[i].id] = i;
  }
}

ModelView.prototype.typeRef = function (libraryId, typeId) {
  var li = this.libIndex[libraryId];
  var types = this.shape.libraries[li].types;
  var ti = types.indexOf(typeId);
  if (ti < 0) {
    return null;
  }
  return '//@libraries.' + li + '/@types.' + ti;
};

ModelView.prototype.hasType = function (libraryId, typeId) {
  var li = this.libIndex[libraryId];
  return li !== undefined && this.shape.libraries[li].types.indexOf(typeId) >= 0;
};

ModelView.prototype.addType = function (libraryId, rawType) {
  var li = this.libIndex[libraryId];
  this.shape.libraries[li].types.push(rawType.id);
  if (!this.created[libraryId]) {
    this.created[libraryId] = [];
  }
  this.created[libraryId].push(rawType);
  return '//@libraries.' + li + '/@types.' + (this.shape.libraries[li].types.length - 1);
};

ModelView.prototype.getOrCreateSimpleType = function (libraryId, id) {
  var ref = this.typeRef(libraryId, id);
  if (ref !== null) {
    return ref;
  }
  return this.addType(libraryId, { eClass: 'SimpleType', id: id, name: id, abstract: false });
};

function valueVariable (id, name, typeRef, value) {
  return {
    eClass: 'Variable',
    id: id,
    name: name,
    static: false,
    types: [{ $ref: typeRef }],
    initialValues: [{ key: 'geppettoModel#' + typeRef, value: value }]
  };
}

/**
 * The port of process(): term info in, raw GeppettoModel out.
 *
 * @param termInfo - the parsed get_term_info JSON for the term
 * @param variableId - the id that was fetched
 * @param shape - the client model (see ModelView); it is updated in place
 *                with the types this call creates
 * @param libs - {dependencies, target, common, obj, swc} library ids
 * @returns {rawModel, created} - the reply and the created types per library
 */
export function termInfoToRawModel (termInfo, variableId, shape, libs) {
  var L = libs || { dependencies: 'ontology', target: 'vfbLibrary', common: 'common', obj: 'OBJLibrary', swc: 'SWCLibrary' };
  var view = new ModelView(shape);
  var synched = function (n) {
    var arr = [];
    for (var i = 0; i < n; i++) {
      arr.push({ synched: true });
    }
    return arr;
  };
  var emptyReply = function () {
    /*
     * No term info (an unknown id): the server answered with a model in
     * which everything is synched and nothing was added, so the merge is a
     * no-op and the caller's callback runs with no instance to show.
     */
    return {
      rawModel: {
        eClass: 'GeppettoModel', id: shape.id, name: shape.name,
        variables: synched(shape.variableCount), libraries: synched(shape.libraries.length),
        dataSources: synched(shape.dataSourceCount), queries: synched(shape.queryCount)
      },
      created: {}
    };
  };
  if (!isObj(termInfo)) {
    return emptyReply();
  }
  var ti = sanitize(termInfo);
  if (isObj(ti) && !Object.prototype.hasOwnProperty.call(ti, 'Id') && !Object.prototype.hasOwnProperty.call(ti, 'Name')) {
    var keyed = Object.prototype.hasOwnProperty.call(ti, variableId) ? ti[variableId] : null;
    var keys = Object.keys(ti);
    if (keyed === null && keys.length === 1) {
      keyed = ti[keys[0]];
    }
    if (isObj(keyed) && (Object.prototype.hasOwnProperty.call(keyed, 'Id') || Object.prototype.hasOwnProperty.call(keyed, 'Name'))) {
      ti = keyed;
    }
  }
  var htmlRef = view.typeRef(L.common, 'HTML');
  var imageRef = view.typeRef(L.common, 'Image');
  var textRef = view.typeRef(L.common, 'Text');

  var tempId = variableId;
  var meta = isObj(ti.Meta) ? ti.Meta : {};
  var id = optStr(ti, 'Id');
  var name = symbolText(optStr(meta, 'Name'));
  if (name === '') {
    name = optStr(ti, 'Name');
  }
  var superTypes = strList(ti, 'SuperTypes');
  var typeString = typesString(strList(ti, 'Tags'));
  var tempName = name !== '' ? name : tempId;

  var parentType = { eClass: 'CompositeType', id: tempId, name: '', abstract: false, superType: [], variables: [] };
  var metaDataType = { eClass: 'CompositeType', id: tempId + '_metadata', name: 'Info', abstract: false, variables: [] };
  var metaRef = view.addType(L.target, metaDataType);
  parentType.variables.push({ eClass: 'Variable', id: tempId + '_meta', name: tempName, static: false, types: [{ $ref: metaRef }] });

  var addHtml = function (data, rowName, reference) {
    if (data === null || data === undefined || data === '') {
      return;
    }
    metaDataType.variables.push(valueVariable(reference, rowName, htmlRef, { eClass: 'HTML', html: data }));
  };
  var addText = function (data, rowName, reference) {
    if (data === null || data === undefined || data === '') {
      return;
    }
    metaDataType.variables.push(valueVariable(reference, rowName, textRef, { eClass: 'Text', text: data }));
  };
  var addThumbnails = function (images, rowName, reference) {
    var v = { eClass: 'Variable', id: reference, name: rowName, static: false, types: [{ $ref: imageRef }] };
    if (images.length > 1) {
      v.initialValues = [{ key: 'geppettoModel#' + imageRef, value: { eClass: 'ArrayValue', elements: images } }];
    } else if (images.length === 1) {
      v.initialValues = [{ key: 'geppettoModel#' + imageRef, value: images[0].initialValue }];
    }
    metaDataType.variables.push(v);
  };
  var imageElement = function (data, imgName, reference, index) {
    return { eClass: 'ArrayElement', index: index, initialValue: { eClass: 'Image', data: secureUrl(data), name: imgName, reference: reference, format: 'PNG' } };
  };

  if (superTypes.length > 0) {
    for (var s = 0; s < superTypes.length; s++) {
      if (superTypes[s].indexOf('_') !== 0) {
        parentType.superType.push({ $ref: view.getOrCreateSimpleType(L.dependencies, superTypes[s]) });
      }
    }
  } else {
    parentType.superType.push({ $ref: view.getOrCreateSimpleType(L.dependencies, 'Orphan') });
  }

  addHtml('<b>' + name + '</b> [' + id + '] ' + typeString, 'Name', 'label');

  var pubs = pubList(ti);
  if (pubs.length > 0 && pubs[0] && pubs[0].title && superTypes.indexOf('pub') >= 0) {
    addHtml('<b>' + pubs[0].title + '</b>', 'Title', 'title');
  }
  var symbol = symbolText(optStr(meta, 'Symbol'));
  if (symbol !== '') {
    addHtml('<b>' + symbol + '</b>', 'Symbol', 'symbol');
  }
  addHtml(mdToHtml(optStr(meta, 'Logo')), 'Logo', 'logo');
  addHtml(mdToHtml(optStr(meta, 'Link')), 'Link', 'link');

  var desc = optStr(meta, 'Description');
  var comment = optStr(meta, 'Comment');
  if (desc !== '' || comment !== '') {
    var d = '';
    if (desc !== '') {
      d += '<span class="terminfo-description">' + mdToHtml(desc) + '</span>';
    }
    if (comment !== '') {
      d += '<br /><span class="terminfo-comment-title">Comment</span><br /><span class="terminfo-comment">' + mdToHtml(comment) + '</span>';
    }
    addHtml(d, 'Description', 'description');
  }

  addHtml(synonymsHtml(ti), 'Alternative Names', 'synonyms');

  var lics = licenseList(ti);
  if (lics.length > 0) {
    var src = '';
    var lic = '';
    for (var l = 0; l < lics.length; l++) {
      var lc = lics[l];
      if (!lc) {
        continue;
      }
      if (lc.source) {
        var srcHtml = lc.source_iri
          ? '<a href="?id=' + lastId(lc.source_iri) + '" data-instancepath="' + lastId(lc.source_iri) + '">' + lc.source + '</a>'
          : lc.source;
        if (src !== '') {
          src += '<br/>';
        }
        src += srcHtml;
      }
      if (lc.label) {
        var licHtml = lc.short_form
          ? '<a href="?id=' + lc.short_form + '" data-instancepath="' + lc.short_form + '">' + lc.label + '</a>'
          : lc.label;
        if (lc.icon) {
          licHtml += ' <img class="terminfo-licenseicon" src="' + secureUrl(lc.icon) + '" title="' + lc.label + '"/>';
        }
        if (lic !== '') {
          lic += '<br/>';
        }
        lic += licHtml;
      }
    }
    var isPub = superTypes.indexOf('pub') >= 0;
    if (src !== '') {
      addHtml('<span class="terminfo-source">' + src + '</span>', isPub ? 'Related DataSets' : 'Source', 'source');
    }
    if (lic !== '' && !isPub) {
      addHtml('<span class="terminfo-license">' + lic + '</span>', 'License', 'license');
    }
  }

  addHtml(metaListToHtml(optStr(meta, 'Types'), 'Classification'), 'Classification', 'type');
  addHtml(relationshipsToHtml(optStr(meta, 'Relationships')), 'Relationships', 'relationships');
  addHtml(metaListToHtml(optStr(meta, 'RelatedIndividuals'), 'related_individuals'), 'Related Individuals', 'related_individuals');
  addHtml(xrefsHtml(ti), 'Cross References', 'xrefs');

  // ---- images ----
  var varId = tempId;
  var varName = tempName;
  if (isObj(ti.Images) && Object.keys(ti.Images).length > 0) {
    var images = ti.Images;
    var imageKeys = Object.keys(images);
    var thumbs = [];
    var downloadData = [];
    var downloadFiles = '';
    var domains = buildDomains(ti);
    var loadedTemplate = '';
    if (imageKeys.length > 1) {
      for (var a = 0; a < AVAILABLE_TEMPLATES.length; a++) {
        if (view.hasType(L.target, AVAILABLE_TEMPLATES[a] + '_metadata')) {
          loadedTemplate = AVAILABLE_TEMPLATES[a];
          break;
        }
      }
    }
    var primaryTemplate = (loadedTemplate !== '' && Object.prototype.hasOwnProperty.call(images, loadedTemplate)) ? loadedTemplate : null;
    var alignedTemplates = [];
    var bibtexFolder = null;
    var geometryLoaded = false;
    var appendDownload = function (fmt, url, template) {
      if (!url) {
        return;
      }
      var https = replaceAll(url, 'http://', 'https://');
      var href = replaceAll(https, 'https://www.virtualflybrain.org/data/', '/data/');
      var v2 = replaceAll(https, 'https://www.virtualflybrain.org/data/', 'https://v2.virtualflybrain.org/data/');
      var safeName = replaceAll(varName, ' ', '_');
      var label;
      var folder;
      var ext;
      if (fmt === 'obj') {
        var pcl = url.indexOf('volume.obj') >= 0;
        label = pcl ? 'Pointcloud (OBJ)' : 'Mesh (OBJ)';
        folder = pcl ? 'PointCloudFiles(OBJ)' : 'MeshFiles(OBJ)';
        ext = 'obj';
      } else if (fmt === 'swc') {
        label = 'Skeleton (SWC)'; folder = 'Skeleton(SWC)'; ext = 'swc';
      } else if (fmt === 'wlz') {
        label = 'Slices (Woolz)'; folder = 'Slices(WOOLZ)'; ext = 'wlz';
      } else {
        label = 'Signal (NRRD)'; folder = 'SignalFiles(NRRD)'; ext = 'nrrd';
      }
      var fname = fmt === 'obj' ? varId + (url.indexOf('volume.obj') >= 0 ? '_pointCloud.obj' : '_mesh.obj') : varId + '.' + ext;
      downloadFiles += '<br>' + label + ': <a download="' + fname + '" href="' + href + '">' + fname + '</a>';
      downloadData.push("'" + fmt + "':{'url':'" + v2 + "','local':'" + template + '/' + folder + '/' + varId + '_(' + safeName + ').' + ext + "'}");
    };
    var addImport = function (kind, url) {
      var suffix = kind === 'obj' ? '_obj' : '_swc';
      var libId = kind === 'obj' ? L.obj : L.swc;
      var importType = {
        eClass: 'ImportType', id: varId + suffix, name: '', abstract: false, url: url,
        modelInterpreterId: kind === 'obj' ? 'objModelInterpreterService' : 'swcModelInterpreter', autoresolve: true
      };
      var ref = view.addType(libId, importType);
      parentType.variables.push({ eClass: 'Variable', id: varId + suffix, name: kind === 'obj' ? '3D Volume' : '3D Skeleton', static: false, types: [{ $ref: ref }] });
    };
    var addSlices = function (url) {
      var fileLocation = replaceAll(replaceAll(replaceAll(replaceAll(url, 'https://', 'http://'), 'www.virtualflybrain.org', 'virtualflybrain.org'),
        'http://virtualflybrain.org/data/', '/disk/data/VFB/IMAGE_DATA/'), 'http://virtualflybrain.org/private/', '/disk/data/VFB/IMAGE_PRIVATE/');
      var data = JSON.stringify({ indexNumber: 0, serverUrl: 'https://www.virtualflybrain.org/fcgi/wlziipsrv.fcgi', fileLocation: fileLocation, subDomains: domains });
      parentType.variables.push(valueVariable(varId + '_slices', 'Stack Viewer Slices', imageRef, { eClass: 'Image', data: data, format: 'IIP', reference: varId }));
    };
    for (var ik = 0; ik < imageKeys.length; ik++) {
      var templateSf = imageKeys[ik];
      var recs = images[templateSf];
      if (!Array.isArray(recs)) {
        continue;
      }
      if (primaryTemplate === null) {
        primaryTemplate = templateSf;
      }
      if (alignedTemplates.indexOf(templateSf) < 0) {
        alignedTemplates.push(templateSf);
      }
      var isPrimaryTemplate = templateSf === primaryTemplate;
      for (var ri = 0; ri < recs.length; ri++) {
        var r = recs[ri];
        if (!isObj(r)) {
          continue;
        }
        var thumb = r.thumbnail_transparent !== null && r.thumbnail_transparent !== undefined ? r.thumbnail_transparent : r.thumbnail;
        if (thumb) {
          var label = r.label !== null && r.label !== undefined ? r.label : r.id;
          if (!isPrimaryTemplate) {
            label = label + ' (' + (Object.prototype.hasOwnProperty.call(TEMPLATE_NAMES, templateSf) ? TEMPLATE_NAMES[templateSf] : templateSf) + ')';
          }
          var ref = isPrimaryTemplate ? r.id : '[' + templateSf + ',' + r.id + ']';
          thumbs.push(imageElement(secureUrl(thumb), label, ref, thumbs.length));
        }
        if (isPrimaryTemplate && !geometryLoaded) {
          if (r.obj && r.obj.indexOf('.obj') >= 0) {
            addImport('obj', replaceAll(secureUrl(r.obj), 'https://', 'http://'));
            appendDownload('obj', r.obj, templateSf);
          }
          if (r.swc && r.swc.indexOf('.swc') >= 0) {
            addImport('swc', replaceAll(secureUrl(r.swc), 'https://', 'http://'));
            appendDownload('swc', r.swc, templateSf);
          }
          if (r.wlz && r.wlz.indexOf('.wlz') >= 0) {
            addSlices(secureUrl(r.wlz));
            appendDownload('wlz', r.wlz, templateSf);
          }
          if (r.nrrd && r.nrrd.indexOf('.nrrd') >= 0) {
            appendDownload('nrrd', r.nrrd, templateSf);
          }
          var fldSrc = (r.nrrd !== null && r.nrrd !== undefined) ? r.nrrd : (r.obj !== null && r.obj !== undefined) ? r.obj : r.wlz;
          if (fldSrc && fldSrc.lastIndexOf('/') >= 0) {
            bibtexFolder = fldSrc.substring(0, fldSrc.lastIndexOf('/') + 1);
          }
          geometryLoaded = true;
        }
      }
    }
    if (primaryTemplate !== null) {
      var pi = alignedTemplates.indexOf(primaryTemplate);
      if (pi >= 0) {
        alignedTemplates.splice(pi, 1);
        alignedTemplates.unshift(primaryTemplate);
      }
    }
    if (alignedTemplates.length > 0) {
      var tplLinks = '';
      for (var t = 0; t < alignedTemplates.length; t++) {
        var tpl = alignedTemplates[t];
        var tplText = tpl === varId && varName ? varName
          : (Object.prototype.hasOwnProperty.call(TEMPLATE_NAMES, tpl) ? TEMPLATE_NAMES[tpl] : tpl);
        if (tplLinks !== '') {
          tplLinks += ', ';
        }
        tplLinks += '<a href="?id=' + tpl + '" data-instancepath="' + tpl + '">' + tplText + '</a>';
        parentType.superType.push({ $ref: view.getOrCreateSimpleType(L.dependencies, tpl) });
      }
      addHtml(tplLinks, 'Aligned to', 'template');
    }
    if (thumbs.length > 0) {
      addThumbnails(thumbs, 'Thumbnail', 'thumbnail');
    }
    if (downloadFiles !== '') {
      if (bibtexFolder !== null) {
        var bibHref = replaceAll(replaceAll(bibtexFolder, 'http://', 'https://'), 'https://www.virtualflybrain.org/data/', '/data/') + 'citations.bibtex';
        downloadFiles += '<br>Remember to cite: <a download="' + varId + '.bibtex" href="' + bibHref + '">citations.bibtex</a>';
        downloadFiles += '<br>The license shown above applies to this data.';
      } else {
        downloadFiles += '<br>Note: see source &amp; license above for terms of reuse and correct attribution.';
      }
      addHtml(downloadFiles, 'Downloads', 'downloads');
      addText('{' + downloadData.join(',') + '}', 'DownloadMeta', 'filemeta');
    }
  }

  if (isObj(ti.Examples) && Object.keys(ti.Examples).length > 0) {
    var exThumbs = [];
    var exKeys = Object.keys(ti.Examples);
    for (var ek = 0; ek < exKeys.length; ek++) {
      var exRecs = ti.Examples[exKeys[ek]];
      if (!Array.isArray(exRecs)) {
        continue;
      }
      for (var er = 0; er < exRecs.length; er++) {
        var x = exRecs[er];
        if (!isObj(x)) {
          continue;
        }
        var xThumb = x.thumbnail_transparent !== null && x.thumbnail_transparent !== undefined ? x.thumbnail_transparent : x.thumbnail;
        if (xThumb) {
          exThumbs.push(imageElement(secureUrl(xThumb), x.label !== null && x.label !== undefined ? x.label : x.id, x.id, exThumbs.length));
        }
      }
    }
    if (exThumbs.length > 0) {
      addThumbnails(exThumbs, 'Available Images', 'examples');
      parentType.superType.push({ $ref: view.getOrCreateSimpleType(L.dependencies, 'hasExamples') });
    }
  }

  addHtml(referencesHtml(ti, pubs), 'References', 'references');

  // ---- queries ----
  if (Array.isArray(ti.Queries)) {
    var pill = 'display:inline-block;min-width:0.9em;padding:1px 6px;margin-right:6px;'
      + 'border-radius:9px;font-size:0.72em;font-weight:bold;line-height:1.5;text-align:center;'
      + 'vertical-align:middle;color:#ffffff;';
    var rows = [];
    for (var q = 0; q < ti.Queries.length; q++) {
      var qu = ti.Queries[q];
      if (!isObj(qu) || qu.query === null || qu.query === undefined) {
        continue;
      }
      var count = qu.count === null || qu.count === undefined ? -1 : javaInt(Number(qu.count));
      var badge;
      var cssExtra = '';
      if (count === 0) {
        badge = '<span class="terminfo-count-badge terminfo-count-empty" style="' + pill + 'background-color:#9b9b9b;" title="0 results">0</span>';
        cssExtra = ' terminfo-query-empty';
      } else if (count > 0) {
        badge = '<span class="terminfo-count-badge" style="' + pill + 'background-color:#428bca;" title="' + count + ' results">' + formatCount(count) + '</span>';
      } else {
        badge = '<i class="popup-icon-link fa fa-quora"></i>';
      }
      var qlabel = qu.label !== null && qu.label !== undefined ? qu.label : qu.query;
      var href = '/org.geppetto.frontend/geppetto?q=' + varId + ',' + qu.query;
      rows.push('<div class="terminfo-query' + cssExtra + '">' + badge
        + '<a href="' + href + '" data-instancepath="' + qu.query + ',' + varId + ',' + name + '">' + qlabel + '</a></div>');
    }
    if (rows.length > 0) {
      addHtml(rows.join(''), 'Query for', 'queries');
    }
  }

  // ---- envelope ----
  var libraries = [];
  for (var li = 0; li < shape.libraries.length; li++) {
    var lib = shape.libraries[li];
    var createdHere = view.created[lib.id];
    if (createdHere && createdHere.length > 0) {
      var typesOut = synched(lib.types.length - createdHere.length).concat(createdHere);
      libraries.push({ eClass: 'GeppettoLibrary', id: lib.id, name: lib.name, types: typesOut });
    } else {
      libraries.push({ synched: true });
    }
  }
  var variable = { eClass: 'Variable', id: tempId, name: tempName, static: false, anonymousTypes: [parentType] };
  var rawModel = {
    eClass: 'GeppettoModel',
    id: shape.id,
    name: shape.name,
    variables: synched(shape.variableCount).concat([variable]),
    libraries: libraries,
    dataSources: synched(shape.dataSourceCount),
    queries: synched(shape.queryCount)
  };
  shape.variableCount += 1;
  return { rawModel: rawModel, created: view.created };
}

/**
 * Describe a live client GeppettoModel for termInfoToRawModel.
 */
export function shapeOf (geppettoModel) {
  var raw = geppettoModel.getWrappedObj();
  var libs = geppettoModel.getLibraries();
  var shape = { id: raw.id, name: raw.name, libraries: [], variableCount: (raw.variables || []).length, dataSourceCount: (raw.dataSources || []).length, queryCount: (raw.queries || []).length };
  for (var i = 0; i < libs.length; i++) {
    var types = libs[i].getTypes();
    var ids = [];
    for (var j = 0; j < types.length; j++) {
      ids.push(types[j].getId());
    }
    shape.libraries.push({ id: libs[i].getId(), name: libs[i].getName(), types: ids });
  }
  return shape;
}

/**
 * Describe a raw GeppettoModel JSON (for the node harness).
 */
export function shapeOfRaw (raw) {
  var shape = { id: raw.id, name: raw.name, libraries: [], variableCount: (raw.variables || []).length, dataSourceCount: (raw.dataSources || []).length, queryCount: (raw.queries || []).length };
  for (var i = 0; i < raw.libraries.length; i++) {
    var lib = raw.libraries[i];
    shape.libraries.push({
      id: lib.id, name: lib.name, types: (lib.types || []).map(function (t) {
        return t.id;
      }) 
    });
  }
  return shape;
}
