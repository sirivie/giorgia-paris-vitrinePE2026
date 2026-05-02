#!/usr/bin/env node
/**
 * GIORGIA paris — Build statique · v2 "SEO"
 * ============================================================
 * Rôle :
 *   1. Récupérer le catalogue depuis Airtable (comme avant).
 *   2. **Pré-rendre** tout le HTML : sections univers, cards produits,
 *      navbar, menu mobile, slider de tabs. Plus rien n'est construit
 *      côté navigateur → les moteurs de recherche voient tout.
 *   3. Injecter les données structurées JSON-LD (Organization,
 *      WholesaleStore, ItemList de Products).
 *   4. Générer robots.txt et sitemap.xml.
 *
 * Exécution locale (pour tester avant de pusher) :
 *   AIRTABLE_API_KEY=xxx node scripts/build.mjs
 *
 * En GitHub Actions : la clé vient du secret AIRTABLE_API_KEY.
 * ============================================================ */

import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

/* ==========================================================================
   1. CONFIGURATION
   ========================================================================== */

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appXLBhHlXD2MCMUj';
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Catalogue';

// Domaine personnalisé pour GitHub Pages. Définir la variable CUSTOM_DOMAIN
// UNIQUEMENT sur le repo de production. En pré-prod, laisser vide : le site
// sera servi à l'URL par défaut github.io et ne volera pas le domaine à la prod.
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || '';

// BASE_PATH : sous-chemin sous lequel le site est servi. À utiliser en
// environnement de qualif où GitHub Pages sert depuis "<user>.github.io/<repo>".
//   • Prod (giorgiaparis.com)              → BASE_PATH non défini → ''
//   • Qualif (sirivie.github.io/giorgia-paris-vitrinePE2026)
//                                          → BASE_PATH='/giorgia-paris-vitrinePE2026'
//
// Toutes les URLs absolues du site (images, pages légales, CSS) seront
// préfixées par BASE_PATH. Sans cette variable, les liens "/img/..." casseraient
// en qualif car ils pointeraient vers la racine du domaine github.io.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

// Origine du site (https://...). Sert pour le sitemap, JSON-LD, og:url, etc.
// Si CUSTOM_DOMAIN est défini → on utilise ce domaine.
// Sinon, si BASE_PATH est défini → on déduit l'URL github.io standard.
// Sinon → fallback prod par défaut.
const SITE_ORIGIN = CUSTOM_DOMAIN
  ? `https://${CUSTOM_DOMAIN}`
  : (process.env.GITHUB_PAGES_ORIGIN || 'https://giorgiaparis.com');

// SITE_BASE : préfixe à appliquer aux URLs internes (chemins absolus du site).
// Concaténé à SITE_ORIGIN pour les URLs canoniques (sitemap.xml, og:url),
// et utilisé seul pour les chemins relatifs au domaine (src d'images, href de liens).
const SITE_BASE = BASE_PATH;        // ex. '' en prod, '/giorgia-paris-vitrinePE2026' en qualif

const TEMPLATE_PATH = resolve('src/template.html');
const OUTPUT_DIR = resolve('dist');
const OUTPUT_HTML = resolve(OUTPUT_DIR, 'index.html');

// Répertoires du pipeline d'images
const IMG_OUTPUT_DIR = resolve(OUTPUT_DIR, 'img');      // dist/img/ — ce qui sera servi en ligne
const IMG_CACHE_DIR = resolve('.image-cache');          // Cache persistant entre les builds GitHub Actions

// Paramètres de compression — à ajuster ici en cas de besoin
const IMG_MAX_WIDTH = 1200;          // Les images plus larges sont redimensionnées
const IMG_JPEG_QUALITY = 82;         // Bon compromis qualité/poids pour JPEG
const IMG_WEBP_QUALITY = 78;         // WebP à qualité équivalente visuelle, mais plus léger
const IMG_CONCURRENCY = 6;           // Téléchargements en parallèle — pas trop pour ne pas taper Airtable trop fort
const IMG_TIMEOUT_MS = 20000;        // Abandonne un download qui traîne au-delà de 20 s

// URLs d'illustration "en dur" (non-Airtable). Centralisées ici pour qu'elles
// soient téléchargées au build, et remplacées par leurs chemins locaux dans le HTML.
const ILLUSTRATION_URLS = {
  heroPexels:
    'https://images.pexels.com/photos/6068969/pexels-photo-6068969.jpeg?auto=compress&cs=tinysrgb&w=1600',
  bannerUnsplash:
    'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1800&h=700&fit=crop&crop=center&auto=format&q=75',
  editorialUnsplash:
    'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&h=1000&fit=crop&crop=top',
};

if (!API_KEY) {
  console.error('✖ AIRTABLE_API_KEY manquant. Ajoutez-le comme secret GitHub ou variable d\'environnement locale.');
  process.exit(1);
}

/* ==========================================================================
   2. UNIVERS (source unique de vérité — ex-JS du template)
   ========================================================================== */

/** Ordre et métadonnées des 5 catégories. Pour réordonner : déplacer une ligne.
 *  Ne PAS changer "id" ni "airtableKey" — ils sont couplés au front et à Airtable. */
const UNIVERS = [
  {
    id: 'summer',
    airtableKey: 'Summer Vibes',
    emoji: '\u{1F30A}',
    label: 'Summer Vibes',
    sub: 'Légèreté, couleur & féminité solaire',
    desc: 'Des pièces qui capturent l\u2019essence de l\u2019été : matières fluides, imprimés vivants, silhouettes libres. Un univers à fort potentiel de vente.',
    insertBannerAfter: true,
  },
  {
    id: 'working',
    airtableKey: 'Urban Woman',
    emoji: '\u{1F454}',
    label: 'Urban Woman',
    sub: 'Élégance, confiance & polyvalence au quotidien.',
    desc: 'Une sélection conçue pour la femme active contemporaine. Du bureau au week-end, découvrez des basiques surélevés et des pièces fluides qui s\u2019adaptent à toutes ses vies.',
  },
  {
    id: 'chic',
    airtableKey: 'Chic & Soirée',
    emoji: '\u2728',
    label: 'Chic & Soirée',
    sub: 'Glamour, strass & dentelle précieuse',
    desc: 'Quand l\u2019élégance s\u2019habille de nuit. Strass, satin, dentelle — des pièces à fort impact visuel pour les boutiques de soirée et d\u2019événementiel.',
    insertEditorialAfter: true,
  },
  {
    id: 'boheme',
    airtableKey: 'Bohème',
    emoji: '\u{1F33F}',
    label: 'Bohème',
    sub: 'Fluidité, crochet & âme libre',
    desc: 'L\u2019esprit free spirit rencontre l\u2019artisanat délicat : crochet, matières naturelles, silhouettes aériennes. Fort potentiel pour les boutiques lifestyle.',
  },
  {
    id: 'casual',
    airtableKey: 'Casual Chic',
    emoji: '\u{1F90D}',
    label: 'Casual',
    sub: 'L\u2019attitude au quotidien, sans effort apparent',
    desc: 'Le quotidien stylé : vestes à caractère, tops ornementés, looks urban-cool qui tournent en boutique.',
  },
];

/** Normalise une clé catégorie pour matching tolérant (case, accents, espaces). */
function normalizeKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map catégorie Airtable → objet univers. Gère les variantes accentuées. */
const CATEGORY_TO_UNIVERS = new Map();
for (const u of UNIVERS) {
  CATEGORY_TO_UNIVERS.set(normalizeKey(u.airtableKey), u);
}
// Aliases usuels : variantes sans accent, alias court…
const ALIASES = [
  ['Chic & Soiree', 'chic'],
  ['Boheme', 'boheme'],
  ['Casual', 'casual'],
];
for (const [key, id] of ALIASES) {
  const u = UNIVERS.find(x => x.id === id);
  if (u) CATEGORY_TO_UNIVERS.set(normalizeKey(key), u);
}

/* ==========================================================================
   3. AIRTABLE FETCH (inchangé fonctionnellement)
   ========================================================================== */

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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });

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

/* ==========================================================================
   4. ALLÈGEMENT DU PAYLOAD (pour __GIORGIA_CATALOG__ — utile aux devs)
   ========================================================================== */

function slimAttachment(att) {
  if (!att || typeof att !== 'object') return att;
  const out = { url: att.url };
  if (att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) {
    out.thumbnails = { large: { url: att.thumbnails.large.url } };
  }
  return out;
}

function isAttachmentArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value[0] &&
    typeof value[0] === 'object' &&
    typeof value[0].url === 'string' &&
    typeof value[0].id === 'string'
  );
}

function slimRecord(rec) {
  const fields = rec.fields || {};
  const slimFields = {};
  for (const [key, value] of Object.entries(fields)) {
    slimFields[key] = isAttachmentArray(value) ? value.map(slimAttachment) : value;
  }
  return { id: rec.id, fields: slimFields };
}

/* ==========================================================================
   5. RÉSOLUTION DES CHAMPS (port Node des helpers ex-JS)
   ========================================================================== */

function fieldPick(fields, keys) {
  if (!fields) return '';
  for (const k of keys) {
    const v = fields[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  // Recherche tolérante sur les clés (insensible à la casse et aux espaces)
  const keysSet = new Set(keys.map(k => k.toLowerCase().trim()));
  for (const k of Object.keys(fields)) {
    if (keysSet.has(k.toLowerCase().trim())) {
      const v = fields[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

function resolveName(f) {
  return fieldPick(f, ['Nom', 'Name', 'Titre', 'Title']);
}

function resolveRef(f) {
  return fieldPick(f, ['Reference', 'Référence', 'Ref', 'REF']);
}

function resolveDesc(f) {
  return fieldPick(f, ['Description', 'Desc']);
}

function resolveCategorie(f) {
  const raw = f?.Categorie ?? f?.['Catégorie'] ?? '';
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : '';
  if (typeof raw === 'object' && raw !== null && raw.name) return String(raw.name).trim();
  return String(raw || '').trim();
}

function resolveBadge(f, n) {
  const keys = n === 2 ? ['Badge2', 'Badge 2', 'BADGE2'] : ['Badge', 'BADGE'];
  for (const k of keys) {
    const raw = f?.[k];
    if (raw == null || raw === '') continue;
    if (typeof raw === 'object' && raw.name) return String(raw.name).trim();
    const s = String(raw).trim();
    if (s) return s;
  }
  return '';
}

function resolveHref(f) {
  const v = fieldPick(f, ['Lien', 'Link', 'URL', 'Url']);
  if (v) return v;
  return (
    'https://wa.me/33686729311?text=' +
    encodeURIComponent('Bonjour GIORGIA paris, je souhaite passer commande pour la collection PE 2026.')
  );
}

function attachmentUrl(att) {
  if (!att || typeof att !== 'object') return '';
  if (att.thumbnails?.large?.url) return att.thumbnails.large.url;
  return att.url || '';
}

function allAttUrls(field) {
  if (!Array.isArray(field)) return [];
  return field.map(attachmentUrl).filter(Boolean);
}

/** Ordre : toutes les images de « Photos », puis Photos2, puis Photos3 (sans doublon). */
function resolvePhotos(f) {
  const p1 = allAttUrls(f?.Photos);
  const p2 = allAttUrls(f?.Photos2 ?? f?.['Photos 2'] ?? f?.['Photo 2']);
  const p3 = allAttUrls(f?.Photos3 ?? f?.['Photos 3'] ?? f?.['Photo 3']);
  const seen = new Set();
  const out = [];
  for (const u of [...p1, ...p2.slice(0, 1), ...p3.slice(0, 1)]) {
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/** Image affichée au survol : Photos2 si présent, sinon 2e image de Photos. */
function resolveHoverUrl(f) {
  const p2 = allAttUrls(f?.Photos2 ?? f?.['Photos 2'] ?? f?.['Photo 2']);
  if (p2[0]) return p2[0];
  const p1 = allAttUrls(f?.Photos);
  return p1[1] || '';
}

/* ==========================================================================
   6. TRI PAR « Ordre »
   ========================================================================== */

function ordreValue(rec) {
  const v = rec?.fields?.Ordre;
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function sortByOrdre(records) {
  return records.slice().sort((a, b) => {
    const oa = ordreValue(a), ob = ordreValue(b);
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  });
}

/* ==========================================================================
   7. ÉCHAPPEMENT HTML
   ========================================================================== */

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ==========================================================================
   7 bis. PIPELINE D'IMAGES
   ==========================================================================
   Toutes les images du site (produits Airtable, hero Pexels, banner Unsplash)
   sont téléchargées au buildtime, compressées, converties en JPEG + WebP et
   stockées dans dist/img/. Les URLs dans le HTML pointent ensuite vers des
   chemins relatifs (/img/xxx.jpg), rendant le site totalement autonome.

   Bénéfices :
   - Images servies depuis GitHub Pages (pas de dépendance à un CDN tiers)
   - Plus d'URL Airtable qui expire toutes les 3-4h
   - WebP pour navigateurs modernes (~30 % plus léger) + JPEG de fallback
   - Les images lourdes (>300 KB) sont automatiquement redimensionnées

   Pipeline:
     URL Airtable → hash SHA-1 → cache miss ? download → compress → .jpg+.webp
                                 cache hit  → copy from .image-cache/

   Le cache (.image-cache/) est persisté entre les builds par GitHub Actions,
   donc une image déjà traitée est réutilisée instantanément.
   ========================================================================== */

/** Registre des images connues : URL source → { jpg, webp, width, height }. */
const imageRegistry = new Map();

/** Stats du pipeline, pour reporting en fin de build. */
const imageStats = { downloaded: 0, cached: 0, failed: 0, totalSavedBytes: 0 };

/**
 * Hash court et stable d'une URL. On extrait la partie "identifiante" de l'URL
 * Airtable (le path, pas le querystring avec le timestamp d'expiration) pour
 * que la même image serve le même hash même si Airtable régénère son token.
 */
function hashImageUrl(url) {
  // Airtable : les URLs ont la forme v3/u/52/52/<timestamp>/<token>/<filename>/<...>
  // On normalise en enlevant le timestamp qui change entre deux builds.
  let normalized = url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('airtableusercontent.com')) {
      // Pour Airtable, on hash uniquement les segments de path qui sont stables.
      // La structure est /v3/u/52/52/<TIMESTAMP>/<TOKEN1>/<FILE_ID>/<TOKEN2>
      // Le token et le timestamp changent à chaque build; seul FILE_ID est stable.
      const parts = u.pathname.split('/').filter(Boolean);
      // Prend tous les segments non-numériques et non-tokens temporels
      const stable = parts.filter(p => !/^\d{10,}$/.test(p));
      normalized = stable.join('/');
    } else {
      // Pour les autres (Pexels, Unsplash), l'URL est stable → hash direct
      normalized = u.origin + u.pathname;
    }
  } catch {
    // URL invalide : hash de la chaîne brute
  }
  return createHash('sha1').update(normalized).digest('hex').slice(0, 10);
}

/** Petite fonction pour formater les bytes. */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Télécharge une URL en buffer avec timeout. */
async function downloadUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Traite une URL image :
 *   1. Cherche dans le cache disque (hash.jpg + hash.webp)
 *   2. Si absent : télécharge, redimensionne, compresse en JPEG et WebP,
 *      écrit dans le cache
 *   3. Copie du cache vers dist/img/
 * Retourne { jpg: '/img/xxx.jpg', webp: '/img/xxx.webp', width, height }.
 * En cas d'échec complet, retourne null → fallback sur l'URL originale.
 */
async function processImage(url) {
  if (!url || typeof url !== 'string') return null;

  // Cache in-memory dans ce même build (une image référencée 3× = 1 seul traitement)
  if (imageRegistry.has(url)) return imageRegistry.get(url);

  const hash = hashImageUrl(url);
  const cacheJpg = join(IMG_CACHE_DIR, `${hash}.jpg`);
  const cacheWebp = join(IMG_CACHE_DIR, `${hash}.webp`);
  const cacheMeta = join(IMG_CACHE_DIR, `${hash}.json`);
  const outJpg = join(IMG_OUTPUT_DIR, `${hash}.jpg`);
  const outWebp = join(IMG_OUTPUT_DIR, `${hash}.webp`);

  let fromCache = false;
  let meta = null;

  // 1. Tentative cache
  try {
    const [j, w, m] = await Promise.all([
      stat(cacheJpg),
      stat(cacheWebp),
      readFile(cacheMeta, 'utf8'),
    ]);
    if (j.size > 0 && w.size > 0) {
      meta = JSON.parse(m);
      fromCache = true;
    }
  } catch {
    // Cache miss, on télécharge
  }

  // 2. Téléchargement + compression si cache miss
  if (!fromCache) {
    try {
      const originalBuf = await downloadUrl(url);
      const originalSize = originalBuf.length;

      // Sharp : analyse + redimensionnement conditionnel
      const pipeline = sharp(originalBuf, { failOn: 'none' }).rotate();
      const metadata = await pipeline.metadata();
      const needsResize = metadata.width && metadata.width > IMG_MAX_WIDTH;

      // Deux sorties parallèles : JPEG + WebP
      const [jpgBuf, webpBuf] = await Promise.all([
        sharp(originalBuf, { failOn: 'none' })
          .rotate()
          .resize({ width: needsResize ? IMG_MAX_WIDTH : undefined, withoutEnlargement: true })
          .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true, progressive: true })
          .toBuffer(),
        sharp(originalBuf, { failOn: 'none' })
          .rotate()
          .resize({ width: needsResize ? IMG_MAX_WIDTH : undefined, withoutEnlargement: true })
          .webp({ quality: IMG_WEBP_QUALITY })
          .toBuffer(),
      ]);

      // On garde les dimensions de la version compressée (source de vérité pour le HTML)
      const finalMeta = await sharp(jpgBuf).metadata();
      meta = {
        width: finalMeta.width,
        height: finalMeta.height,
        jpgBytes: jpgBuf.length,
        webpBytes: webpBuf.length,
        originalBytes: originalSize,
      };

      // Écriture dans le cache
      await mkdir(IMG_CACHE_DIR, { recursive: true });
      await Promise.all([
        writeFile(cacheJpg, jpgBuf),
        writeFile(cacheWebp, webpBuf),
        writeFile(cacheMeta, JSON.stringify(meta)),
      ]);

      imageStats.downloaded++;
      // Comparaison brute original vs jpg compressé (proxy utile du gain)
      if (originalSize > jpgBuf.length) {
        imageStats.totalSavedBytes += originalSize - jpgBuf.length;
      }
    } catch (err) {
      imageStats.failed++;
      console.warn(`  ⚠ Échec image ${url.slice(0, 80)}… : ${err.message}`);
      imageRegistry.set(url, null);
      return null;
    }
  } else {
    imageStats.cached++;
  }

  // 3. Copie cache → dist/img/
  await mkdir(IMG_OUTPUT_DIR, { recursive: true });
  await Promise.all([
    copyFile(cacheJpg, outJpg),
    copyFile(cacheWebp, outWebp),
  ]);

  const result = {
    jpg: `${SITE_BASE}/img/${hash}.jpg`,
    webp: `${SITE_BASE}/img/${hash}.webp`,
    width: meta.width,
    height: meta.height,
  };
  imageRegistry.set(url, result);
  return result;
}

/** Traite un tableau d'URLs en parallèle contrôlé. */
async function processImagesBatch(urls, concurrency = IMG_CONCURRENCY) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  let idx = 0;
  async function worker() {
    while (idx < uniqueUrls.length) {
      const i = idx++;
      await processImage(uniqueUrls[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Collecte toutes les URLs images à traiter depuis les records Airtable +
 *  les URLs en dur du template (hero Pexels, banners Unsplash). */
function collectAllImageUrls(records) {
  const urls = [];
  // 1. Images des produits Airtable
  for (const rec of records) {
    const f = rec.fields || {};
    urls.push(...resolvePhotos(f));
  }
  // 2. Images d'illustration en dur : hero Pexels + banner Unsplash + editorial Unsplash
  urls.push(
    ILLUSTRATION_URLS.heroPexels,
    ILLUSTRATION_URLS.bannerUnsplash,
    ILLUSTRATION_URLS.editorialUnsplash
  );
  return urls;
}

/**
 * Retourne les chemins locaux pour une URL donnée, ou null si l'image n'a pas
 * pu être traitée (fallback sur l'URL d'origine). À appeler dans les fonctions
 * de rendu HTML après que processImagesBatch soit terminé.
 */
function localImageFor(url) {
  if (!url) return null;
  return imageRegistry.get(url) || null;
}

/* ==========================================================================
   8. RENDU DES CARDS PRODUIT
   ========================================================================== */

function renderProductCard(fields, isPriority, univ) {
  const nom = resolveName(fields);
  const ref = resolveRef(fields);
  const desc = resolveDesc(fields);
  const href = resolveHref(fields);
  const photos = resolvePhotos(fields);
  const hoverUrl = resolveHoverUrl(fields);
  const badge = resolveBadge(fields, 1);
  const badge2 = resolveBadge(fields, 2);

  if (!photos.length) return ''; // Pas de photo = pas de card

  const mainSrc = photos[0];
  const altBase = (nom || ref || 'Produit').trim();
  // Alt SEO-friendly : nom + catégorie + marque + (ref si dispo)
  const altMain = ref
    ? `${altBase} — Réf. ${ref} — ${univ.label} — Grossiste GIORGIA paris`
    : `${altBase} — ${univ.label} — Grossiste GIORGIA paris`;

  // Résolution des chemins locaux (fallback URL Airtable si échec du pipeline)
  const mainLocal = localImageFor(mainSrc);
  const mainDisplayUrl = mainLocal ? mainLocal.jpg : mainSrc;

  // Hover URL en version locale aussi (pour que l'effet survol utilise le JPEG local)
  const hoverLocal = hoverUrl ? localImageFor(hoverUrl) : null;
  const hoverDisplayUrl = hoverLocal ? hoverLocal.jpg : hoverUrl;
  const dataHover = hoverDisplayUrl && hoverDisplayUrl !== mainDisplayUrl
    ? ` data-hover-url="${esc(hoverDisplayUrl)}"` : '';

  const loading = isPriority ? 'eager' : 'lazy';
  const fetchprio = isPriority ? ' fetchpriority="high"' : '';
  const dims = mainLocal ? ` width="${mainLocal.width}" height="${mainLocal.height}"` : '';

  // URL WebP du hover (à passer en data-attribute pour que le JS puisse swap
  // à la fois le src JPEG ET le srcset WebP du <picture>).
  const hoverWebp = hoverLocal ? hoverLocal.webp : '';
  const dataHoverWebp = hoverWebp && hoverWebp !== (mainLocal && mainLocal.webp)
    ? ` data-hover-webp="${esc(hoverWebp)}"` : '';

  let h = '';
  h += `<a class="prod-card" target="_blank" rel="noopener noreferrer" href="${esc(href)}">`;
  h += `<div class="prod-media">`;
  h += `<div class="prod-img">`;

  // <picture> : WebP si supporté (~98% du trafic depuis 2021), JPEG sinon.
  // Le JS swap simultanément le srcset du <source> et le src du <img>
  // lorsqu'on change d'image (hover, clic vignette).
  h += `<picture>`;
  if (mainLocal) {
    h += `<source srcset="${esc(mainLocal.webp)}" type="image/webp">`;
  }
  h += `<img class="prod-img-primary" src="${esc(mainDisplayUrl)}" alt="${esc(altMain)}" loading="${loading}"${fetchprio} decoding="async"${dims}${dataHover}${dataHoverWebp}>`;
  h += `</picture>`;

  if (badge || badge2) {
    h += `<div class="prod-badges">`;
    if (badge) {
      const cls = /promo/i.test(badge) && !/nouvelle/i.test(badge)
        ? 'prod-badge prod-badge--promo' : 'prod-badge';
      h += `<div class="${cls}">${esc(badge)}</div>`;
    }
    if (badge2) h += `<div class="prod-badge2">${esc(badge2)}</div>`;
    h += `</div>`;
  }

  h += `<div class="prod-wm logo" aria-hidden="true"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>`;
  h += `</div>`; // .prod-img

  if (photos.length > 1) {
    h += `<div class="prod-thumbs">`;
    photos.forEach((p, i) => {
      const cls = i === 0 ? 'prod-thumb is-active' : 'prod-thumb';
      const altThumb = `${altBase} — vue ${i + 1}`;
      const thumbLocal = localImageFor(p);
      // Pour les thumbnails, on sert l'image JPEG locale directement (pas de
      // <picture> ici car ce sont de petites images, le gain WebP est marginal
      // sur les vignettes 80×80px). On stocke aussi data-webp pour permettre
      // au JS de swap correctement le srcset du <picture> principal.
      const thumbSrc = thumbLocal ? thumbLocal.jpg : p;
      const thumbWebp = thumbLocal ? thumbLocal.jpg.replace(/\.jpg$/, '.webp') : '';
      const dataWebp = thumbWebp ? ` data-webp="${esc(thumbWebp)}"` : '';
      h += `<span class="${cls}" role="button" tabindex="0" aria-label="Voir la vue ${i + 1} de ${esc(altBase)}"${dataWebp}>`;
      h += `<img src="${esc(thumbSrc)}" alt="${esc(altThumb)}" loading="lazy" decoding="async">`;
      h += `</span>`;
    });
    h += `</div>`;
  }

  h += `</div>`; // .prod-media

  h += `<div class="prod-info">`;
  // H3 = nom produit SEUL (bon pour le SEO ; la référence passe sur une ligne à part)
  h += `<h3 class="prod-name">${esc(nom || '(Sans nom)')}</h3>`;
  if (ref) h += `<p class="prod-ref">Réf. ${esc(ref)}</p>`;
  if (desc) h += `<p class="prod-desc">${esc(desc)}</p>`;
  h += `</div>`;

  h += `</a>`;
  return h;
}

/* ==========================================================================
   9. RENDU DES SECTIONS UNIVERS + BANNERS ÉDITORIAUX
   ========================================================================== */

function renderUniversSection(univ, products) {
  let h = '';
  h += `<section class="univ-sec" id="${univ.id}" style="scroll-margin-top:130px" aria-labelledby="title-${univ.id}">`;
  h += `<div class="sec-hdr">`;
  h += `<div class="sec-line"></div>`;
  h += `<div class="sec-center">`;
  h += `<span class="sec-eye">GIORGIA paris — Collection Printemps-Été 2026</span>`;
  h += `<h2 class="sec-title" id="title-${univ.id}">${esc(univ.label)}</h2>`;
  h += `<span class="sec-sub">${esc(univ.sub)}</span>`;
  h += `<p class="sec-desc">${esc(univ.desc)}</p>`;
  h += `</div>`;
  h += `<div class="sec-line"></div>`;
  h += `</div>`;

  h += `<div class="carousel-outer" data-carousel="${univ.id}">`;
  h += `<button class="car-btn car-btn-prev" aria-label="Produit précédent" onclick="carMove('${univ.id}',-1)">&#8592;</button>`;
  h += `<button class="car-btn car-btn-next" aria-label="Produit suivant" onclick="carMove('${univ.id}',1)">&#8594;</button>`;
  h += `<div class="carousel-clip">`;

  if (!products.length) {
    h += `<p class="catalog-loading" role="status">Aucun produit dans cette catégorie pour le moment.</p>`;
  }

  h += `<div class="carousel-track" id="track-${univ.id}">`;
  h += `<div id="grid-${univ.id}" class="catalog-grid-root">`;

  // Priorité de chargement : 4 premières de "summer" (au-dessus de la ligne de flottaison)
  products.forEach((rec, i) => {
    const isPriority = (univ.id === 'summer' && i < 4);
    h += renderProductCard(rec.fields || {}, isPriority, univ);
  });

  h += `</div>`; // grid
  h += `</div>`; // track
  h += `</div>`; // clip
  h += `<div class="car-dots" id="dots-${univ.id}"></div>`;
  h += `</div>`; // carousel-outer

  h += `</section>`;
  return h;
}

function renderFeatBanner() {
  // Chemin local (JPEG) si dispo, sinon fallback sur l'URL Unsplash originale
  const local = localImageFor(ILLUSTRATION_URLS.bannerUnsplash);
  const bgUrl = local ? local.jpg : ILLUSTRATION_URLS.bannerUnsplash;
  return [
    '<div class="feat-banner">',
    `<div class="feat-bg" style="background-image:url('${esc(bgUrl)}')"></div>`,
    '<div class="feat-grad"></div>',
    '<div class="feat-content">',
    '<div class="logo"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>',
    '<h3>Vêtir les boutiques<br>qui font la différence.</h3>',
    '<p>Des pièces sélectionnées pour leur potentiel commercial. Pour les boutiques qui refusent le stock dormant — et qui veulent des marges réelles.</p>',
    '<a class="btn-hero-p" href="#contact">Contacter notre équipe</a>',
    '</div>',
    '</div>',
  ].join('');
}

function renderEditorial() {
  const local = localImageFor(ILLUSTRATION_URLS.editorialUnsplash);
  // Balise <picture> pour bénéficier du WebP si dispo
  let imgHtml;
  if (local) {
    imgHtml =
      '<picture>' +
      `<source srcset="${esc(local.webp)}" type="image/webp">` +
      `<img src="${esc(local.jpg)}" width="${local.width}" height="${local.height}" alt="GIORGIA paris — Showroom parisien et collection Printemps-Été 2026" loading="lazy" decoding="async">` +
      '</picture>';
  } else {
    imgHtml = `<img src="${esc(ILLUSTRATION_URLS.editorialUnsplash)}" alt="GIORGIA paris — Showroom parisien et collection Printemps-Été 2026" loading="lazy" decoding="async">`;
  }
  return [
    '<div class="editorial">',
    '<div class="ed-img">',
    imgHtml,
    '</div>',
    '<div class="ed-txt">',
    '<div class="logo"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>',
    '<span class="sec-eye">Grossiste B2B · Partenaire depuis 2007</span>',
    '<h2 class="sec-title" style="color:white">Votre stock.<br>Notre expertise.</h2>',
    '<p>Basé à Aubervilliers, au cœur du triangle d\u2019or du prêt-à-porter des grossistes parisiens, nous accompagnons les boutiques de mode partout en France et à l\u2019international.</p>',
    '<p>Rejoignez les centaines de revendeurs qui font confiance à GIORGIA paris chaque saison.</p>',
    '<a class="btn-ed" href="#contact">Devenir revendeur</a>',
    '</div>',
    '</div>',
  ].join('');
}

/* ==========================================================================
   10. RENDU DE LA NAVBAR & MENUS
   ========================================================================== */

function renderNavLinks() {
  return UNIVERS.map(u =>
    `<li><a href="#${u.id}">${esc(u.label)}</a></li>`
  ).join('');
}

function renderMobMenuLinks() {
  const links = UNIVERS.map(u =>
    `<a href="#${u.id}" onclick="closeMob()">${esc(u.label)}</a>`
  ).join('');
  return links + `<a href="#contact" onclick="closeMob()" style="color:var(--gold)">Commander</a>`;
}

function renderUniversTabs() {
  return UNIVERS.map(u =>
    `<a href="#${u.id}" class="utab">${u.emoji} ${esc(u.label)}</a>`
  ).join('');
}

/* ==========================================================================
   11. DONNÉES STRUCTURÉES JSON-LD
   ========================================================================== */

function buildOrganizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WholesaleStore',
    '@id': `${SITE_ORIGIN}${SITE_BASE}/#organization`,
    name: 'GIORGIA paris',
    alternateName: 'Giorgia Paris',
    description: 'Grossiste en prêt-à-porter féminin basé à Aubervilliers, près de Paris. Collection Printemps-Été 2026, pièces tendances pour boutiques indépendantes. Minimum de commande 100€ HT.',
    url: `${SITE_ORIGIN}${SITE_BASE}/`,
    telephone: '+33686729311',
    email: 'giorgia93300@gmail.com',
    foundingDate: '2007',
    priceRange: '€€',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '70 rue de la Haie Coq',
      addressLocality: 'Aubervilliers',
      postalCode: '93300',
      addressRegion: 'Île-de-France',
      addressCountry: 'FR',
    },
    areaServed: ['FR', 'BE', 'LU', 'CH', 'IT', 'ES', 'DE', 'NL', 'GB', 'IE', 'PT', 'AT'],
    sameAs: [
      'https://instagram.com/giorgia.auber',
      'https://tiktok.com/@giorgia.paris56',
    ],
  };
}

function buildItemListLd(records) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Catalogue GIORGIA paris — Collection Printemps-Été 2026',
    description: 'Sélection de pièces prêt-à-porter féminin pour boutiques professionnelles.',
    numberOfItems: records.length,
    itemListElement: records.map((rec, i) => {
      const f = rec.fields || {};
      const nom = resolveName(f);
      const photos = resolvePhotos(f);
      const descRaw = resolveDesc(f);
      const ref = resolveRef(f);
      const cat = resolveCategorie(f);

      const product = {
        '@type': 'Product',
        name: nom || `Article ${ref || i + 1}`,
        brand: { '@type': 'Brand', name: 'GIORGIA paris' },
      };
      if (photos[0]) product.image = photos.slice(0, 3); // jusqu'à 3 images
      if (descRaw) product.description = descRaw.slice(0, 300); // cap à 300 car.
      if (ref) product.sku = ref;
      if (cat) product.category = cat;

      return {
        '@type': 'ListItem',
        position: i + 1,
        item: product,
      };
    }),
  };
}

function buildWebSiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}${SITE_BASE}/#website`,
    url: `${SITE_ORIGIN}${SITE_BASE}/`,
    name: 'GIORGIA paris',
    description: 'Catalogue du grossiste prêt-à-porter féminin GIORGIA paris — Collection Printemps-Été 2026.',
    inLanguage: 'fr-FR',
    publisher: { '@id': `${SITE_ORIGIN}${SITE_BASE}/#organization` },
  };
}

/** Génère le <script type="application/ld+json"> complet (plusieurs objets). */
function renderJsonLd(records) {
  const graph = [buildOrganizationLd(), buildWebSiteLd(), buildItemListLd(records)];
  // Échappement </script> (sécurité parseur HTML)
  const safe = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/<\/script>/gi, '<\\/script>');
  return `<script type="application/ld+json">${safe}</script>`;
}

/* ==========================================================================
   12. ROBOTS.TXT & SITEMAP.XML
   ========================================================================== */

function renderRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    '# Autorise explicitement les grands crawlers',
    'User-agent: Googlebot',
    'Allow: /',
    '',
    'User-agent: Googlebot-Image',
    'Allow: /',
    '',
    'User-agent: Bingbot',
    'Allow: /',
    '',
    '# Bloquer les crawlers IA qui génèrent beaucoup de charge sans apporter de trafic',
    '# (décommenter si souhaité — laisse par défaut activé pour ne pas bloquer)',
    '# User-agent: GPTBot',
    '# Disallow: /',
    '',
    `Sitemap: ${SITE_ORIGIN}${SITE_BASE}/sitemap.xml`,
    '',
  ].join('\n');
}

function renderSitemapXml(now) {
  const lastmod = now.toISOString().split('.')[0] + '+00:00';

  // URLs du site. La home est prioritaire (1.0, changefreq=weekly).
  // Les pages légales sont là pour le signal E-E-A-T et la conformité mais
  // ne sont pas des pages de destination marketing → priority 0.3, rarement
  // modifiées.
  const urls = [
    { loc: `${SITE_ORIGIN}${SITE_BASE}/`,                      priority: '1.0', changefreq: 'weekly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/mentions-legales/`,     priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/cgv/`,                  priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/confidentialite/`,      priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/politique-retour/`,     priority: '0.3', changefreq: 'yearly' },
  ];

  const body = urls.map(u => [
    '  <url>',
    `    <loc>${u.loc}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    body,
    '</urlset>',
    '',
  ].join('\n');
}

/* ==========================================================================
   13 bis. COPIE DES PAGES LÉGALES
   ==========================================================================
   Source : src/legal/ (4 fichiers HTML + 1 CSS partagé)
   Destination :
     - dist/legal/legal-styles.css           (CSS accessible à /legal/legal-styles.css)
     - dist/mentions-legales/index.html      (URL : /mentions-legales/)
     - dist/cgv/index.html                   (URL : /cgv/)
     - dist/confidentialite/index.html       (URL : /confidentialite/)
     - dist/politique-retour/index.html      (URL : /politique-retour/)

   Le mapping est volontaire : le nom de fichier source (ex.
   "politique-confidentialite.html") n'est PAS l'URL finale (qui sera
   "/confidentialite/") pour des raisons SEO et de lisibilité.
*/

// Mapping : nom du fichier source → nom du dossier de sortie (= URL)
const LEGAL_PAGES_MAP = {
  'mentions-legales.html':         'mentions-legales',
  'cgv.html':                      'cgv',
  'politique-confidentialite.html':'confidentialite',
  'politique-retour.html':         'politique-retour',
};

async function copyLegalPages() {
  const srcDir = resolve('src/legal');

  // Vérifier que le dossier existe (il peut manquer si tu n'as pas encore
  // déposé les fichiers — dans ce cas on skip sans crasher le build).
  try {
    await stat(srcDir);
  } catch {
    console.warn('⚠ src/legal/ introuvable — pages légales non déployées.');
    console.warn('  Pour les activer, déposez les 4 HTML + le CSS dans src/legal/.');
    return { deployed: false };
  }

  // 1. Copier la CSS partagée vers dist/legal/ (CSS = pas de transformation
  // d'URL nécessaire, on copie tel quel)
  const cssSrc = join(srcDir, 'legal-styles.css');
  const cssDstDir = resolve(OUTPUT_DIR, 'legal');
  const cssDst = join(cssDstDir, 'legal-styles.css');
  try {
    await stat(cssSrc);
    await mkdir(cssDstDir, { recursive: true });
    await copyFile(cssSrc, cssDst);
    console.log(`  • CSS → ${SITE_BASE}/legal/legal-styles.css`);
  } catch {
    console.warn('  ⚠ legal-styles.css manquant dans src/legal/');
  }

  // 2. Copier chaque page HTML dans son dossier dédié, EN PRÉFIXANT les
  // liens internes par SITE_BASE. Ainsi la même source HTML fonctionne
  // en prod (SITE_BASE='') et en qualif (SITE_BASE='/giorgia-paris-vitrinePE2026').
  const deployedPages = [];
  for (const [srcFile, outFolder] of Object.entries(LEGAL_PAGES_MAP)) {
    const srcPath = join(srcDir, srcFile);
    try {
      await stat(srcPath);
    } catch {
      console.warn(`  ⚠ ${srcFile} manquant dans src/legal/ — page /${outFolder}/ non déployée.`);
      continue;
    }
    const outDir = resolve(OUTPUT_DIR, outFolder);
    const outPath = join(outDir, 'index.html');
    await mkdir(outDir, { recursive: true });

    // Lecture + transformation des URLs internes
    let html = await readFile(srcPath, 'utf8');
    html = applyBasePathToHtml(html);

    await writeFile(outPath, html, 'utf8');
    deployedPages.push(outFolder);
    console.log(`  • ${srcFile} → ${SITE_BASE}/${outFolder}/`);
  }

  return { deployed: true, pages: deployedPages };
}

/**
 * Transforme les URLs internes absolues (commençant par '/') en y ajoutant
 * SITE_BASE. À utiliser sur les pages légales avant de les écrire dans dist/.
 *
 * Exemples (avec SITE_BASE='/giorgia-paris-vitrinePE2026') :
 *   href="/"                          → href="/giorgia-paris-vitrinePE2026/"
 *   href="/cgv/"                      → href="/giorgia-paris-vitrinePE2026/cgv/"
 *   href="/legal/legal-styles.css"    → href="/giorgia-paris-vitrinePE2026/legal/legal-styles.css"
 *   href="https://example.com/x"      → inchangé (pas '/' en tête)
 *   href="mailto:..."                 → inchangé
 *   href="#anchor"                    → inchangé
 *
 * En prod, SITE_BASE='' donc cette fonction est un no-op.
 */
function applyBasePathToHtml(html) {
  if (!SITE_BASE) return html; // Prod : aucune transformation
  // On match : href="/..." ou src="/..."  où le / suit immédiatement le ".
  // Lookbehind exclu pour éviter '//' (URLs protocole-relative type //cdn.example.com).
  return html.replace(/(\bhref|\bsrc)="\/(?!\/)/g, `$1="${SITE_BASE}/`);
}

/* ==========================================================================
   13. AUDIT DU POIDS DES IMAGES (inchangé)
   ========================================================================== */

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
        const url = att?.thumbnails?.large?.url || att.url;
        if (url) items.push({ ref, nom, field: key, url });
      }
    }
  }
  return items;
}

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

function fmtKB(bytes) {
  if (bytes == null) return '   ? KB';
  return (bytes / 1024).toFixed(0).padStart(4) + ' KB';
}

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
      ref: m.ref, nom: m.nom, field: m.field,
      sizeKB: Math.round(m.sizeBytes / 1024), url: m.url,
    })),
  };
}

/* ==========================================================================
   14. PIPELINE PRINCIPAL
   ========================================================================== */

async function main() {
  const t0 = Date.now();

  console.log(`→ Airtable : ${BASE_ID} / ${TABLE_NAME}`);
  console.log(`→ Site origin : ${SITE_ORIGIN}`);
  console.log('→ Récupération des enregistrements…');
  const records = await fetchAllRecords();
  console.log(`✓ ${records.length} produits récupérés.`);

  // Tri par champ « Ordre »
  const sortedRecords = sortByOrdre(records);

  // Payload allégé pour __GIORGIA_CATALOG__ (conservé par compatibilité)
  const slim = sortedRecords.map(slimRecord);

  // ===================================================================
  //  PIPELINE D'IMAGES : téléchargement + compression + WebP
  // -------------------------------------------------------------------
  //  Téléchargées depuis Airtable/Pexels/Unsplash, compressées (JPEG qualité
  //  82 + WebP qualité 78), écrites dans dist/img/. Le cache .image-cache/
  //  est persisté entre builds par GitHub Actions → les images déjà traitées
  //  sont instantanément réutilisées (pas de re-download, pas de re-compress).
  // ===================================================================
  console.log('→ Pipeline d\'images (download + compression + WebP)…');
  const tImg0 = Date.now();
  const allImgUrls = collectAllImageUrls(sortedRecords);
  console.log(`  ${new Set(allImgUrls).size} URLs uniques à traiter (cache = .image-cache/).`);
  await processImagesBatch(allImgUrls);
  const tImgMs = Date.now() - tImg0;
  console.log(`✓ Images : ${imageStats.downloaded} téléchargées, ${imageStats.cached} depuis le cache, ${imageStats.failed} échecs (${(tImgMs / 1000).toFixed(1)}s).`);
  if (imageStats.totalSavedBytes > 0) {
    console.log(`  Gain total de compression : ${fmtBytes(imageStats.totalSavedBytes)}.`);
  }

  // Audit webperf des images (post-compression : évalue l'état de Airtable
  // "à la source", pas des images servies qui sont maintenant locales)
  let imageAudit = null;
  if (process.env.SKIP_IMAGE_AUDIT !== '1') {
    try { imageAudit = await auditImageWeights(records); }
    catch (err) { console.warn('⚠ Audit images échoué (non bloquant) :', err.message); }
  }

  // Regroupement par univers
  const byUnivers = new Map();
  for (const u of UNIVERS) byUnivers.set(u.id, []);
  const unmatched = [];
  for (const rec of sortedRecords) {
    const cat = resolveCategorie(rec.fields || {});
    const univ = CATEGORY_TO_UNIVERS.get(normalizeKey(cat));
    if (univ) byUnivers.get(univ.id).push(rec);
    else if (cat) unmatched.push(cat);
  }
  if (unmatched.length) {
    console.warn(`⚠ Catégories non reconnues dans Airtable :`, [...new Set(unmatched)]);
  }
  for (const u of UNIVERS) {
    console.log(`  • ${u.label} : ${byUnivers.get(u.id).length} produits`);
  }

  // Rendu des sections
  console.log('→ Rendu du HTML…');
  let sectionsHtml = '';
  for (const u of UNIVERS) {
    const recs = byUnivers.get(u.id) || [];
    sectionsHtml += renderUniversSection(u, recs);
    if (u.insertBannerAfter) sectionsHtml += renderFeatBanner();
    if (u.insertEditorialAfter) sectionsHtml += renderEditorial();
  }

  // JSON-LD
  const jsonLdHtml = renderJsonLd(sortedRecords);

  // Lecture template
  const template = await readFile(TEMPLATE_PATH, 'utf8');

  // Payload JS (conservé pour compat / debug)
  const now = new Date();
  const payload = {
    version: 2,
    generatedAt: now.toISOString(),
    count: slim.length,
    products: slim,
  };
  const payloadJson = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  const catalogDataScript = `<script id="giorgia-catalog-data">window.__GIORGIA_CATALOG__=${payloadJson};</script>`;

  // Chemin local pour l'image hero (fallback sur Pexels si le traitement a échoué)
  const heroLocal = localImageFor(ILLUSTRATION_URLS.heroPexels);
  const heroImageUrl = heroLocal ? heroLocal.jpg : ILLUSTRATION_URLS.heroPexels;

  // Substitutions des placeholders
  const replacements = [
    ['<!-- UNIVERS_NAV_TABS -->', renderUniversTabs()],
    ['<!-- NAV_LINKS -->', renderNavLinks()],
    ['<!-- MOB_MENU_LINKS -->', renderMobMenuLinks()],
    ['<!-- UNIVERS_SECTIONS -->', sectionsHtml],
    ['<!-- JSON_LD -->', jsonLdHtml],
    ['<!-- CATALOG_DATA -->', catalogDataScript],
    ['<!-- SITE_ORIGIN -->', SITE_ORIGIN],
    ['<!-- SITE_BASE -->', SITE_BASE],
  ];

  let html = template;
  for (const [ph, val] of replacements) {
    if (!html.includes(ph)) {
      throw new Error(
        `Placeholder ${ph} introuvable dans src/template.html. ` +
        `Vérifiez que vous avez bien mis à jour template.html à la version v2.`
      );
    }
    // SITE_BASE et SITE_ORIGIN apparaissent plusieurs fois (canonical, og:url,
    // hreflang, footer). On utilise split/join pour remplacer toutes les
    // occurrences en une passe.
    if (ph === '<!-- SITE_BASE -->' || ph === '<!-- SITE_ORIGIN -->') {
      html = html.split(ph).join(val);
    } else {
      html = html.replace(ph, val);
    }
  }

  // HERO_IMAGE_URL apparaît 4 fois dans le template (og:image, twitter:image,
  // <link rel="preload">, background CSS) → remplacement GLOBAL, pas simple.
  if (html.includes('<!-- HERO_IMAGE_URL -->')) {
    html = html.split('<!-- HERO_IMAGE_URL -->').join(heroImageUrl);
  }

  // Écriture des fichiers de sortie
  console.log('→ Écriture de dist/…');
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_HTML, html, 'utf8');
  await writeFile(resolve(OUTPUT_DIR, 'robots.txt'), renderRobotsTxt(), 'utf8');
  await writeFile(resolve(OUTPUT_DIR, 'sitemap.xml'), renderSitemapXml(now), 'utf8');

  if (CUSTOM_DOMAIN) {
    await writeFile(resolve(OUTPUT_DIR, 'CNAME'), `${CUSTOM_DOMAIN}\n`, 'utf8');
  }

  // Copie des pages légales depuis src/legal/ vers dist/ avec URLs propres.
  console.log('→ Copie des pages légales…');
  await copyLegalPages();

  await writeFile(
    resolve(OUTPUT_DIR, 'build-info.json'),
    JSON.stringify(
      {
        generatedAt: payload.generatedAt,
        count: payload.count,
        version: 3,
        imagePipeline: {
          downloaded: imageStats.downloaded,
          cached: imageStats.cached,
          failed: imageStats.failed,
          compressionSavedKB: Math.round(imageStats.totalSavedBytes / 1024),
        },
        imageAudit,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const sizeKB = (html.length / 1024).toFixed(1);
  const durMs = Date.now() - t0;
  console.log(`✓ dist/index.html : ${sizeKB} KB, ${slim.length} produits, ${durMs} ms.`);
  console.log(`✓ dist/robots.txt, dist/sitemap.xml, dist/build-info.json générés.`);
}

main().catch((err) => {
  console.error('✖ Build échoué :', err.stack || err.message);
  process.exit(1);
});
