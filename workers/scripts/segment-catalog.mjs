/**
 * Extiende (o lista) el catálogo de zonas / objeciones de un tenant sin redeploy (0073).
 *
 * El clasificador arma su prompt desde `tenant_config.zone_catalog` / `objection_catalog`
 * en cada turno, así que una entrada nueva aplica en el siguiente mensaje. El sistema
 * NUNCA amplía el catálogo solo: lo hace una persona después de revisar las notas
 * `[zona: otro]` / `[objeción: otro]` de los contactos.
 *
 * Crea también la etiqueta en GHL a mano (`zona:<slug>` / `objecion:<slug>`, con su
 * categoría y color) ANTES de agregarla aquí: si el bot la asigna y no existe, GHL la
 * crea sin categoría.
 *
 * Uso:
 *   node scripts/segment-catalog.mjs <tenantId> zones|objections list
 *   node scripts/segment-catalog.mjs <tenantId> zones add <slug> "<label>" ["<hint>" ...]
 *   node scripts/segment-catalog.mjs <tenantId> zones remove <slug>
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, kind, action, slugArg, label, ...hints] = process.argv.slice(2);
const column = kind === 'zones' ? 'zone_catalog' : kind === 'objections' ? 'objection_catalog' : null;
if (!tenantId || !column || !['list', 'add', 'remove'].includes(action ?? '')) {
  console.error('uso: node scripts/segment-catalog.mjs <tenantId> zones|objections list|add|remove ...');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await supabase.from('tenant_config').select(column).eq('tenant_id', tenantId).maybeSingle();
if (error || !data) {
  console.error('no se pudo leer el tenant:', error?.message ?? 'sin fila');
  process.exit(1);
}
const catalog = Array.isArray(data[column]) ? data[column] : [];

if (action === 'list') {
  for (const e of catalog) console.log(`${e.slug}\t${e.label ?? ''}\t${(e.hints ?? []).join(', ')}`);
  console.log(`${catalog.length} entradas en ${column}`);
  process.exit(0);
}

// Misma regla de slug que ghl/tags.ts tagSlug(): minúsculas, sin acentos, guiones.
const slug = (slugArg ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
if (!slug || slug === 'otro') {
  console.error('slug inválido (vacío u "otro", que es implícito)');
  process.exit(1);
}

let next;
if (action === 'remove') {
  next = catalog.filter((e) => e.slug !== slug);
  if (next.length === catalog.length) {
    console.error(`no existe ${slug} en ${column}`);
    process.exit(1);
  }
} else {
  if (catalog.some((e) => e.slug === slug)) {
    console.error(`ya existe ${slug} en ${column} — quítalo primero si quieres cambiarlo`);
    process.exit(1);
  }
  next = [...catalog, { slug, label: label?.trim() || slug, hints: hints.map((h) => h.trim()).filter(Boolean) }];
}

const { error: upErr } = await supabase.from('tenant_config').update({ [column]: next }).eq('tenant_id', tenantId);
if (upErr) {
  console.error('no se pudo escribir:', upErr.message);
  process.exit(1);
}
console.log(`${action === 'add' ? 'agregado' : 'quitado'} ${slug} — ${column} ahora tiene ${next.length} entradas`);
