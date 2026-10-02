// UI: single screen, mobile Safari first.

import {
  openFile, isDirty, changeCount, needsC2paChoice, errors, addable, addField, revert, revertAll, buildOutput,
  provenance, checkC2paHash, isChanged,
} from './editor.js';
import { fieldError, detectImageMime, PICTURE_TYPES } from './fields.js';
import { formatBytes } from './bytes.js';

const $ = (id) => document.getElementById(id);
let doc = null;
let urls = [];
let pendingShare = null;
let busy = false;
let flash = '';

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'type', 'name', 'placeholder', 'rows', 'maxLength', 'accept', 'href', 'download', 'title']);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

function blobUrl(data, type) {
  const u = URL.createObjectURL(new Blob([data], { type }));
  urls.push(u);
  return u;
}

function showError(msg) {
  const e = $('error');
  e.textContent = msg || '';
  e.hidden = !msg;
  if (msg) e.scrollIntoView({ block: 'nearest' });
}

function setStatus(msg) {
  $('status').textContent = msg;
}

// ---- file open ----

$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (doc && isDirty(doc) && !confirm('Discard unsaved changes?')) return;
  showError(null);
  pendingShare = null;
  $('shareAgain').hidden = true;
  try {
    doc = await openFile(file);
  } catch (err) {
    doc = null;
    render();
    showError(`${file.name}: ${err.message}`);
    return;
  }
  $('filename').value = file.name;
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (doc && isDirty(doc)) e.preventDefault();
});

// ---- rendering ----

function render() {
  flash = '';
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  $('main').hidden = !doc;
  $('bar').hidden = !doc;
  document.body.classList.toggle('has-doc', !!doc);
  if (!doc) return;
  renderSummary();
  renderC2pa();
  renderEdit();
  renderPreserve();
  renderProtected();
  renderTechnical();
  refreshBar();
}

function renderSummary() {
  const s = $('summary');
  fill(s,
    h('h2', { class: 'fname' }, doc.file.name),
    h('p', { class: 'meta' }, `${formatBytes(doc.file.size)} · ${doc.summary}`),
    doc.readOnly ? h('p', { class: 'warn' }, doc.readOnly) : null,
    ...doc.notes.filter((n) => n !== doc.readOnly).map((n) => h('p', { class: 'warn' }, n)),
    h('div', { id: 'provenance' }),
  );
  renderProvenance();
}

function renderProvenance() {
  const box = $('provenance');
  if (!box) return;
  const list = provenance(doc);
  fill(box, ...list.map((p) => h('div', { class: 'prov' },
    h('div', { class: 'prov-head' }, 'Suno provenance', h('span', { class: 'chip' }, p.where)),
    h('div', { class: 'kv' }, h('span', null, 'created'), h('span', { class: 'mono' }, p.created)),
    h('div', { class: 'kv' }, h('span', null, 'id'), h('span', { class: 'mono' }, p.id)),
  )));
}

function shortType(t) {
  if (!t) return null;
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

function renderC2pa() {
  const box = $('c2pa');
  const c = doc.c2pa;
  box.hidden = !c;
  if (!c) { fill(box); return; }
  const s = c.summary;
  const hashResult = h('span', { class: 'hash-result' });
  let hashRow;
  if (c.binding.kind === 'data') {
    const btn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      btn.disabled = true;
      hashResult.textContent = 'Reading whole file…';
      hashResult.className = 'hash-result';
      try {
        const r = await checkC2paHash(doc);
        if (r.result === 'match') { hashResult.textContent = `Data hash matches (${r.alg})`; hashResult.classList.add('ok'); }
        else if (r.result === 'mismatch') { hashResult.textContent = `Data hash does not match${r.message ? ' — ' + r.message : ''}`; hashResult.classList.add('bad'); }
        else hashResult.textContent = r.message || r.result;
      } catch (err) {
        hashResult.textContent = 'Hash check failed: ' + err.message;
      }
      btn.disabled = false;
    } }, 'Check data hash');
    hashRow = h('div', { class: 'hash-row' }, btn, hashResult);
  } else if (c.binding.kind === 'other') {
    hashRow = h('p', null, `Hash: Not checked (${c.binding.label})`);
  } else {
    hashRow = h('p', null, 'Hash: no hard-binding assertion found');
  }
  const radio = (value, label) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name: 'c2pa-choice', value, checked: c.choice === value, onchange: () => { c.choice = value; refreshBar(); } }),
    h('span', null, label));
  fill(box,
    h('h2', null, 'C2PA manifest present'),
    h('p', { class: 'meta' }, `In ${c.where}${s ? ` · ${s.manifestCount} manifest${s.manifestCount === 1 ? '' : 's'}` : ''}`),
    c.error ? h('p', { class: 'warn' }, `Could not parse manifest: ${c.error}`) : null,
    s && s.generator.length ? h('div', { class: 'kv' }, h('span', null, 'Generator'), h('span', null, s.generator.join(', '))) : null,
    s && s.actions.length ? h('div', { class: 'sub' }, h('h3', null, 'Actions'), h('ul', null, s.actions.map((a) => h('li', null,
      h('span', { class: 'mono' }, a.action || '?'),
      a.digitalSourceType ? h('div', { class: 'small', title: a.digitalSourceType }, `digitalSourceType: ${shortType(a.digitalSourceType)}`) : null,
      a.softwareAgent ? h('div', { class: 'small' }, `agent: ${a.softwareAgent}`) : null,
      a.when ? h('div', { class: 'small' }, `when: ${a.when}`) : null)))) : null,
    s && s.suno.length ? h('div', { class: 'sub' }, h('h3', null, 'com.suno.provenance'), s.suno.map(([k, v]) => h('div', { class: 'kv' }, h('span', null, k), h('span', { class: 'mono' }, v)))) : null,
    s ? h('details', { class: 'sub' }, h('summary', null, `Assertions (${s.assertions.length})`), h('ul', null, s.assertions.map((a) => h('li', { class: 'mono' }, a)))) : null,
    hashRow,
    h('p', { class: 'small' }, 'Signatures and certificates are not validated.'),
    doc.readOnly ? null : h('fieldset', { class: 'choice' },
      h('legend', null, 'On save'),
      radio('remove', 'Remove C2PA manifest'),
      radio('keep', 'Keep manifest (will no longer validate)'),
      h('p', { class: 'small' }, 'Required when any other edit is pending. Removal deletes only the manifest container.')),
  );
}

function chips(f) {
  return [
    f.group && f.group !== 'ilst' ? h('span', { class: 'chip' }, f.group) : null,
    f.key && f.key !== 'junk' ? h('span', { class: 'chip key' }, f.key.trim()) : null,
  ];
}

function groupHeader(title, sub, extra) {
  return h('div', { class: 'group-head' }, h('div', null, h('h2', null, title), sub ? h('p', { class: 'small' }, sub) : null), extra || null);
}

function renderEdit() {
  const box = $('edit');
  const fields = doc.fields.filter((f) => f.cls === 'edit');
  let add = null;
  const opts = addable(doc);
  if (opts.length) {
    add = h('select', { class: 'add', 'aria-label': 'Add field', onchange: (e) => {
      const key = e.target.value;
      if (!key) return;
      const nf = addField(doc, key);
      render();
      if (nf) {
        const el = document.querySelector(`[data-uid="${nf.uid}"] input, [data-uid="${nf.uid}"] textarea`);
        if (el) el.focus();
        else { const w = document.querySelector(`[data-uid="${nf.uid}"]`); if (w) w.scrollIntoView({ block: 'center' }); }
      }
    } }, h('option', { value: '' }, 'Add field…'), opts.map((o) => h('option', { value: o.key }, o.label)));
  }
  fill(box,
    groupHeader('Edit', null, add),
    fields.length ? fields.map(renderEditField) : h('p', { class: 'empty' }, 'No editable fields yet.'),
  );
}

function fieldShell(f, body) {
  const err = h('div', { class: 'err' });
  const revertBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { revert(doc, f); render(); } }, f.isNew ? 'Discard' : 'Revert');
  const delBtn = f.deletable && !doc.readOnly && !f.isNew
    ? h('button', { class: 'btn small danger', type: 'button', onclick: () => { f.deleted = !f.deleted; render(); } }, f.deleted ? 'Restore' : 'Delete')
    : null;
  const wrap = h('div', { class: 'field', 'data-uid': f.uid },
    h('div', { class: 'field-head' },
      h('span', { class: 'label' }, f.label), ...chips(f),
      h('span', { class: 'spacer' }),
      revertBtn, delBtn),
    body,
    err,
    f.note ? h('div', { class: 'note' }, f.note) : null,
  );
  wrap._err = err;
  wrap._revert = revertBtn;
  updateField(wrap, f, false);
  return wrap;
}

function updateField(wrap, f, refresh = true) {
  const changed = isChanged(f);
  wrap.classList.toggle('changed', changed);
  wrap.classList.toggle('deleted', f.deleted);
  wrap.classList.toggle('new', f.isNew);
  const e = fieldError(f);
  wrap.classList.toggle('invalid', !!e);
  wrap._err.textContent = e || '';
  wrap._revert.hidden = !(changed || f.isNew) || (f.deleted && !f.isNew);
  if (refresh) { flash = ''; refreshBar(); renderProvenance(); }
}

function renderEditField(f) {
  const dis = f.deleted || !!doc.readOnly;
  let wrap;
  const onInput = (fn) => (e) => { fn(e.target.value); updateField(wrap, f); };
  let body;
  if (f.kind === 'picture') {
    body = renderPicture(f);
  } else if (f.kind === 'comment' || f.kind === 'lyrics') {
    body = h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('label', { class: 'mini' }, 'Lang', h('input', { class: 'lang', value: f.value.lang, maxLength: 3, disabled: dis, autocapitalize: 'off', spellcheck: 'false', oninput: onInput((v) => { f.value = { ...f.value, lang: v }; }) })),
        h('label', { class: 'mini grow' }, 'Description', h('input', { value: f.value.desc, disabled: dis, oninput: onInput((v) => { f.value = { ...f.value, desc: v }; }) }))),
      h('textarea', { rows: f.kind === 'lyrics' ? 10 : 3, value: f.value.text, disabled: dis, 'aria-label': f.label, oninput: onInput((v) => { f.value = { ...f.value, text: v }; }) }));
  } else if (f.kind === 'multiline') {
    body = h('textarea', { rows: f.key === '©lyr' ? 10 : 3, value: f.value, disabled: dis, 'aria-label': f.label, oninput: onInput((v) => { f.value = v; }) });
  } else {
    body = h('input', {
      type: f.kind === 'url' ? 'url' : 'text', value: f.value, disabled: dis, placeholder: f.placeholder || null,
      inputmode: f.inputmode || null, 'aria-label': f.label, autocapitalize: f.kind === 'url' ? 'off' : null,
      oninput: onInput((v) => { f.value = v; }),
    });
  }
  wrap = fieldShell(f, body);
  return wrap;
}

function renderPicture(f) {
  const v = f.value;
  const info = h('div', { class: 'small' });
  let img = null;
  if (v.data) {
    img = h('img', { class: 'cover', alt: f.label, src: blobUrl(v.data, v.mime || 'application/octet-stream') });
    img.addEventListener('load', () => { info.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${v.mime} · ${formatBytes(v.data.length)}`; });
    img.addEventListener('error', () => { info.textContent = `${v.mime} · ${formatBytes(v.data.length)} (preview unavailable)`; });
    info.textContent = `${v.mime} · ${formatBytes(v.data.length)}`;
  } else {
    info.textContent = 'No image chosen';
  }
  const canReplace = !f.readOnly && !f.deleted && !doc.readOnly;
  const picker = canReplace ? h('label', { class: 'btn small' }, v.data ? 'Replace…' : 'Choose image…',
    h('input', { type: 'file', accept: 'image/jpeg,image/png', class: 'hidden-input', onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const data = new Uint8Array(await file.arrayBuffer());
      const mime = detectImageMime(data);
      if (!mime) { showError('Cover must be a JPEG or PNG image.'); return; }
      showError(null);
      f.value = { ...f.value, mime, data };
      render();
    } })) : null;
  return h('div', { class: 'picture' },
    img,
    h('div', { class: 'stack' },
      info,
      v.ptype !== undefined && f.key === 'APIC' ? h('div', { class: 'small' }, `Type: ${PICTURE_TYPES[v.ptype] || v.ptype}`) : null,
      v.desc ? h('div', { class: 'small' }, `Description: ${v.desc}`) : null,
      f.readOnly ? h('div', { class: 'small' }, f.key === 'APIC' ? 'Only the front cover is replaceable.' : 'Only JPEG/PNG covers are replaceable.') : null,
      picker));
}

function renderPreserve() {
  const box = $('preserve');
  const fields = doc.fields.filter((f) => f.cls === 'preserve');
  box.hidden = !fields.length;
  fill(box,
    groupHeader('Preserve', 'Read-only. Written back byte-for-byte unless deleted.'),
    fields.map((f) => {
      const del = f.deletable && !doc.readOnly
        ? h('button', { class: 'btn small danger', type: 'button', onclick: () => { f.deleted = !f.deleted; render(); } }, f.deleted ? 'Restore' : 'Delete')
        : null;
      return h('div', { class: `field ro${f.deleted ? ' deleted changed' : ''}`, 'data-uid': f.uid },
        h('div', { class: 'field-head' }, h('span', { class: 'label' }, f.label), ...chips(f), h('span', { class: 'spacer' }), del),
        f.display ? h('div', { class: 'value' }, f.display) : null);
    }),
  );
}

function renderProtected() {
  const box = $('protected');
  const fields = doc.fields.filter((f) => f.cls === 'protected');
  box.hidden = !fields.length;
  fill(box,
    groupHeader('Protected', 'Never modified.'),
    fields.map((f) => h('div', { class: 'field ro protected' + (f.c2pa && doc.c2pa && doc.c2pa.choice === 'remove' ? ' deleted' : '') },
      h('div', { class: 'field-head' }, h('span', { class: 'label' }, f.label), ...chips(f)),
      f.display ? h('div', { class: 'value' }, f.display) : null)),
  );
}

function renderTechnical() {
  fill($('technical'),
    groupHeader('Technical', null),
    h('dl', { class: 'tech' }, doc.technical.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
  );
}

function refreshBar() {
  const n = changeCount(doc);
  const errs = errors(doc).length;
  const parts = [n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes'];
  if (errs) parts.push(`${errs} invalid`);
  if (needsC2paChoice(doc)) parts.push('choose a C2PA option');
  if (!busy) setStatus(flash || parts.join(' · '));
  $('dot').classList.toggle('dirty', n > 0);
  $('save').disabled = busy || !!doc.readOnly || n === 0;
  $('revertAll').disabled = busy || n === 0;
  document.title = (n ? '• ' : '') + 'Metadata Editor';
  const p = document.querySelector('#protected .deleted');
  if (doc.c2pa && !!p !== (doc.c2pa.choice === 'remove')) renderProtected();
}

// ---- save ----

$('revertAll').addEventListener('click', () => {
  if (!doc) return;
  revertAll(doc);
  render();
});

function cleanName(s) {
  return s.replace(/[\/\\\u0000-\u001f]/g, '').trim();
}

// Returns 'shared' | 'downloaded' | 'cancelled' | 'pending'.
async function deliver(file) {
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { canShare = false; }
  if (canShare) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      if (err && err.name === 'NotAllowedError') {
        pendingShare = file;
        $('shareAgain').hidden = false;
        return 'pending';
      }
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

// After a delivered save, the saved file becomes the new baseline.
async function delivered(result, file) {
  const msg = { shared: 'Saved via Share', downloaded: 'Saved (download)', cancelled: 'Share cancelled — not saved', pending: 'Ready — tap “Share file”' }[result];
  if (result === 'shared' || result === 'downloaded') {
    try {
      doc = await openFile(file);
      $('filename').value = file.name;
      render();
    } catch (err) {
      showError('Saved, but re-reading the output failed: ' + err.message);
    }
  }
  flash = msg;
  refreshBar();
}

$('save').addEventListener('click', async () => {
  if (!doc || busy) return;
  const errs = errors(doc);
  if (errs.length) {
    const w = document.querySelector(`[data-uid="${errs[0].field.uid}"]`);
    if (w) w.scrollIntoView({ block: 'center' });
    setStatus(`${errs[0].field.label}: ${errs[0].error}`);
    return;
  }
  if (needsC2paChoice(doc)) {
    $('c2pa').scrollIntoView({ block: 'start' });
    setStatus('Choose: remove or keep the C2PA manifest');
    return;
  }
  busy = true;
  showError(null);
  pendingShare = null;
  $('shareAgain').hidden = true;
  setStatus('Building…');
  refreshBar();
  try {
    const blob = await buildOutput(doc);
    const name = cleanName($('filename').value) || doc.file.name;
    const file = new File([blob], name, { type: blob.type });
    const result = await deliver(file);
    busy = false;
    await delivered(result, file);
  } catch (err) {
    busy = false;
    showError(err.message);
    flash = 'Not saved';
    refreshBar();
  }
});

$('shareAgain').addEventListener('click', async () => {
  if (!pendingShare) return;
  const file = pendingShare;
  pendingShare = null;
  $('shareAgain').hidden = true;
  await delivered(await deliver(file), file);
});
