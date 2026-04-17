#!/usr/bin/env node
/**
 * GIORGIA paris — Build statique
 * ============================================================
 * Rôle : récupérer le catalogue depuis Airtable, en extraire
 * uniquement ce qui sert à l'affichage, puis injecter ces données
 * dans src/template.html pour produire dist/index.html.
 *
 * Exécution locale (pour tester avant de pusher) :
 *   AIRTABLE_API_KEY=xxx node scripts/build.mjs
 *
 * En GitHub Actions : la clé vient du secret AIRTABLE_API_KEY.
 * ============================================================ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---------- Configuration ----------

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appXLBhHlXD2MCMUj';
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Catalogue';

// Domaine personnalisé pour GitHub Pages. Définir la variable CUSTOM_DOMAIN
// UNIQUEMENT sur le repo de production. En pré-prod, laisser vide : le site
// sera servi à l'URL par défaut github.io et ne volera pas le domaine à la prod.
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || '';

const TEMPLATE_PATH = resolve('src/template.html');
const OUTPUT_DIR = resolve('dist');
const OUTPUT_HTML = resolve(OUTPUT_DIR, 'index.html');

// ---------- Garde-fous ----------

if (!API_KEY) {
  console.error('✖ AIRTABLE_API_KEY manquant. Ajoutez-le comme secret GitHub ou variable d\'environnement locale.');
  process.exit(1);
}

// ---------- Airtable ----------

/** Récupère tous les enregistrements, en suivant la pagination. */
async function fetchAllRecords() {
  const base = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_NAME)}`;
  const all = [];
  let offset = '';

  do {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    params.append('sort[0][field]', 'Ordre');
    params.append('sort[0][direction]', 'asc');
    if (offset) params.set('offset', offset);

    const url = `${base}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Airtable ${res.status} ${res.statusText} — ${txt.slice(0, 400)}`);
    }

    const data = await res.json();
    if (Array.isArray(data.records)) all.push(...data.records);
    offset = data.offset || '';
  } while (offset);

  return all;
}

// ---------- Allègement du payload ----------

/**
 * Ne garde que url + thumbnails.large d'une pièce jointe.
 * Jette id, filename, type, width/height top-level, small/full thumbnails,
 * etc. : c'est tout ce que le front utilise.
 */
function slimAttachment(att) {
  if (!att || typeof att !== 'object') return att;
  const out = { url: att.url };
  if (att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) {
    out.thumbnails = { large: { url: att.thumbnails.large.url } };
  }
  return out;
}

/**
 * Détecte si un champ est un tableau d'attachments Airtable.
 * Un attachment a toujours .id et .url.
 */
function isAttachmentArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value[0] &&
    typeof value[0] === 'object' &&
    typeof value[0].url === 'string' &&
    typeof value[0].id === 'string'
  );
}

/** Allège un enregistrement complet : seuls les attachments sont transformés. */
function slimRecord(rec) {
  const fields = rec.fields || {};
  const slimFields = {};
  for (const [key, value] of Object.entries(fields)) {
    slimFields[key] = isAttachmentArray(value) ? value.map(slimAttachment) : value;
  }
  return { id: rec.id, fields: slimFields };
}

// ---------- Audit du poids des images ----------

/**
 * Extrait toutes les URLs d'images (thumbnails.large en priorité, sinon url)
 * des enregistrements, avec la référence produit pour les identifier.
 */
function collectImageUrls(records) {
  const items = [];
  for (const rec of records) {
    const f = rec.fields || {};
    const ref = f.Reference || f.Référence || f.REF || rec.id;
    const nom = f.Nom || f.Name || f.Produit || '';
    for (const [key, value] of Object.entries(f)) {
      if (!Array.isArray(value)) continue;
      for (const att of value) {
        if (!att || typeof att !== 'object') continue;
        const url =
          (att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) ||
          att.url;
        if (url) items.push({ ref, nom, field: key, url });
      }
    }
  }
  return items;
}

/** HEAD request pour récupérer la taille d'une image. */
async function measureUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

/** Exécute les mesures en parallèle mais avec une concurrence max de 8. */
async function measureAll(items, concurrency = 8) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const size = await measureUrl(items[i].url);
      results[i] = { ...items[i], sizeBytes: size };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Formate un nombre de bytes en KB lisible. */
function fmtKB(bytes) {
  if (bytes == null) return '   ? KB';
  return (bytes / 1024).toFixed(0).padStart(4) + ' KB';
}

/**
 * Mesure toutes les images et affiche un rapport. Retourne aussi la
 * liste triée pour l'injecter dans build-info.json.
 */
async function auditImageWeights(records) {
  console.log('→ Audit du poids des images (thumbnails.large)…');
  const items = collectImageUrls(records);
  console.log(`  ${items.length} images à mesurer.`);

  const measured = await measureAll(items, 8);
  const sized = measured.filter(m => typeof m.sizeBytes === 'number');
  const failed = measured.length - sized.length;

  sized.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const totalKB = sized.reduce((s, m) => s + m.sizeBytes, 0) / 1024;
  const avgKB = sized.length ? totalKB / sized.length : 0;

  console.log(`✓ Mesurées : ${sized.length}/${items.length}` +
              (failed ? ` (${failed} échecs)` : '') + '.');
  console.log(`  Poids total : ${totalKB.toFixed(0)} KB — moyenne : ${avgKB.toFixed(0)} KB/image.`);

  // Seuil : thumbnail.large Airtable fait typiquement 40-150 KB.
  // Tout ce qui dépasse 300 KB est suspect (image originale très lourde
  // ou champ "Photos" pointant sur un attachment non-imagé).
  const heavy = sized.filter(m => m.sizeBytes > 300 * 1024);
  if (heavy.length) {
    console.log(`⚠ ${heavy.length} images > 300 KB à compresser dans Airtable :`);
    for (const m of heavy.slice(0, 20)) {
      const who = [m.ref, m.nom].filter(Boolean).join(' — ') || '(sans ref)';
      console.log(`    ${fmtKB(m.sizeBytes)}  [${m.field}]  ${who}`);
    }
    if (heavy.length > 20) console.log(`    … et ${heavy.length - 20} autres.`);
  } else {
    console.log('✓ Aucune image > 300 KB. Catalogue bien optimisé.');
  }

  // Top 10 dans tous les cas, pour référence.
  console.log('  Top 10 des images les plus lourdes :');
  for (const m of sized.slice(0, 10)) {
    const who = [m.ref, m.nom].filter(Boolean).join(' — ') || '(sans ref)';
    console.log(`    ${fmtKB(m.sizeBytes)}  [${m.field}]  ${who}`);
  }

  return {
    totalImages: items.length,
    measured: sized.length,
    totalKB: Math.round(totalKB),
    avgKB: Math.round(avgKB),
    heavyCount: heavy.length,
    top20Heavy: heavy.slice(0, 20).map(m => ({
      ref: m.ref,
      nom: m.nom,
      field: m.field,
      sizeKB: Math.round(m.sizeBytes / 1024),
      url: m.url,
    })),
  };
}

// ---------- Pipeline principal ----------

async function main() {
  const t0 = Date.now();

  console.log(`→ Airtable : ${BASE_ID} / ${TABLE_NAME}`);
  console.log('→ Récupération des enregistrements…');
  const records = await fetchAllRecords();
  console.log(`✓ ${records.length} produits récupérés.`);

  const slim = records.map(slimRecord);

  // Audit webperf des images (HEAD requests sur tous les thumbnails).
  // Désactivable via SKIP_IMAGE_AUDIT=1 pour les builds locaux rapides.
  let imageAudit = null;
  if (process.env.SKIP_IMAGE_AUDIT !== '1') {
    try {
      imageAudit = await auditImageWeights(records);
    } catch (err) {
      console.warn('⚠ Audit images échoué (non bloquant) :', err.message);
    }
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: slim.length,
    products: slim,
  };

  console.log('→ Lecture du template…');
  const template = await readFile(TEMPLATE_PATH, 'utf8');

  if (!template.includes('<!-- CATALOG_DATA -->')) {
    throw new Error(
      'Placeholder <!-- CATALOG_DATA --> introuvable dans src/template.html. ' +
      'Vérifiez que le template n\'a pas été écrasé par une version ancienne.'
    );
  }

  // On remplace LE placeholder (une seule occurrence) par un <script> JSON.
  // L'échappement de </script> dans le JSON évite toute cassure du parseur HTML.
  const jsonString = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  const injection = `<script id="giorgia-catalog-data">window.__GIORGIA_CATALOG__=${jsonString};</script>`;

  const html = template.replace('<!-- CATALOG_DATA -->', injection);

  console.log('→ Écriture de dist/…');
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_HTML, html, 'utf8');

  // Fichier CNAME pour conserver le domaine personnalisé sur gh-pages.
  if (CUSTOM_DOMAIN) {
    await writeFile(resolve(OUTPUT_DIR, 'CNAME'), `${CUSTOM_DOMAIN}\n`, 'utf8');
  }

  // Petit fichier de diagnostic, pratique pour vérifier la fraîcheur d'un déploiement.
  await writeFile(
    resolve(OUTPUT_DIR, 'build-info.json'),
    JSON.stringify(
      {
        generatedAt: payload.generatedAt,
        count: payload.count,
        imageAudit,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const sizeKB = (html.length / 1024).toFixed(1);
  const durMs = Date.now() - t0;
  console.log(`✓ dist/index.html généré : ${sizeKB} KB, ${slim.length} produits, ${durMs} ms.`);
}

main().catch((err) => {
  console.error('✖ Build échoué :', err.message);
  process.exit(1);
});
