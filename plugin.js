/// <reference path="./kino.d.ts" />

// Hentaila — plugin para Kino
// Series y episodios hentai en español de https://hentaila.com/
//
// El sitio es SvelteKit: cada página sirve sus datos limpios en <ruta>/__data.json
// (formato devalue: un arreglo donde data[0] es el esquema y los números son
// referencias a posiciones). Este plugin habla con esos endpoints:
//
//   /catalogo/__data.json?search=…&order=…&genre=…&status=…&page=N   listado
//   /media/<slug>/__data.json                                        serie + episodios
//   /media/<slug>/<n>/__data.json                                   embeds del episodio
//
// Los embeds (Voe, MP4Upload, Streamtape, YourUpload, SendVid, …) se resuelven a un
// MP4 directo en resolve(); el ajuste "Servidor preferido" (Voe por defecto)
// decide cuál se prueba primero. El resto de servidores cae al navegador oculto
// ("browser": true en el manifiesto). Los CDNs rotan, por eso el manifiesto
// declara "streamHosts": "any".
//
// Contenido solo para adultos (+18): todos los ítems llevan adult: true.

const HOST = "https://hentaila.com";
const CDN = "https://cdn.hentaila.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_BUSQUEDA = 100; // tope de Kino: search
const MAX_FILA = 60; // tope de Kino: cada fila de Inicio
const MAX_VER_MAS = 100; // tope de Kino: browse
const MAX_PAGINAS = 5; // páginas de hentaila que se piden como máximo por listado

// ---------------- utilidades ----------------

function log(...args) {
  try {
    kino.log(...args);
  } catch (_) {}
}

function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v != null && v !== "" ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function esKinoError(e) {
  return !!e && typeof e.name === "string" && e.name.indexOf("KinoError_") === 0;
}

function scan(re, texto) {
  const out = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function hostDe(url) {
  const m = String(url || "").match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1] : "";
}

function originDe(url) {
  const m = String(url || "").match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1] + "/" : HOST + "/";
}

function quitarEspacios(t) {
  return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
}

function recortar(t, n) {
  t = quitarEspacios(t);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ---------------- red ----------------

async function bajarTexto(url, opciones) {
  const r = await kino.fetch(url, opciones || {});
  if (r.status === 429) {
    throw kino.error("rate_limited", "hentaila está limitando las peticiones");
  }
  if (!r.ok) {
    throw kino.error(
      r.status === 404 ? "not_found" : "unavailable",
      "hentaila.com respondió " + r.status
    );
  }
  return r.text();
}

function encabezados(extra) {
  return Object.assign(
    {
      "User-Agent": UA,
      Accept: "application/json, text/html, */*",
      "Accept-Language": "es-ES,es;q=0.9",
      Referer: HOST + "/",
    },
    extra || {}
  );
}

// ---------------- devalue (SvelteKit __data.json) ----------------

// data[i]: data[0] es el esquema raíz; un objeto es un esquema (clave →
// referencia o esquema anidado), un arreglo es una lista de referencias y un
// número dentro de un esquema/arreglo es una posición. Las cadenas "-0"…"-4"
// codifican undefined/NaN/Infinity/-Infinity/-0.
function hidratar(values) {
  const especiales = {
    "-0": undefined,
    "-1": NaN,
    "-2": Infinity,
    "-3": -Infinity,
    "-4": -0,
  };
  const listos = new Array(values.length);

  function valorDeRef(i) {
    if (i < 0 || i >= values.length) return undefined;
    if (listos[i] !== undefined) return listos[i];
    return valor(values[i], i, 0);
  }

  function literal(v) {
    if (typeof v === "string" && Object.prototype.hasOwnProperty.call(especiales, v)) {
      return especiales[v];
    }
    return v;
  }

  function valor(v, i, nivel) {
    if (nivel > 32) return undefined;
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return literal(v);
    if (typeof v === "number") return v; // un número en su propia posición es un literal
    if (Array.isArray(v)) {
      const arr = v.map((e) =>
        typeof e === "number" ? valorDeRef(e) : valor(e, -1, nivel + 1)
      );
      if (i >= 0) listos[i] = arr;
      return arr;
    }
    if (typeof v === "object") {
      // esquema: cada clave apunta a una referencia o a otro esquema
      const obj = {};
      for (const k of Object.keys(v)) {
        const val = v[k];
        if (typeof val === "number") obj[k] = valorDeRef(val);
        else if (val !== null && typeof val === "object") obj[k] = valor(val, -1, nivel + 1);
        else obj[k] = literal(val);
      }
      if (i >= 0) listos[i] = obj;
      return obj;
    }
    return undefined;
  }

  const raiz = values[0];
  if (raiz !== null && typeof raiz === "object" && !Array.isArray(raiz)) {
    return valor(raiz, 0, 0);
  }
  return {};
}

// Pide <ruta>/__data.json y devuelve las raíces ya hidratadas (una por layout).
const cacheDatos = new Map();

async function datosDeSvelte(ruta) {
  if (cacheDatos.has(ruta)) return cacheDatos.get(ruta);
  // el sufijo __data.json va antes de la query (?…), no después
  const corte = ruta.indexOf("?");
  const base = (corte === -1 ? ruta : ruta.slice(0, corte)).replace(/\/+$/, "");
  const qs = corte === -1 ? "" : ruta.slice(corte);
  const cuerpo = await bajarTexto(HOST + base + "/__data.json" + qs, {
    headers: encabezados(),
  });
  let json;
  try {
    json = JSON.parse(cuerpo);
  } catch (_) {
    throw kino.error("unavailable", "respuesta __data.json inválida");
  }
  const nodes = Array.isArray(json.nodes) ? json.nodes : [json];
  const raices = [];
  for (const n of nodes) {
    if (n && n.type === "data" && Array.isArray(n.data) && n.data.length) {
      try {
        raices.push(hidratar(n.data));
      } catch (e) {
        log("hidratar falló en un nodo:", String((e && e.message) || e));
      }
    }
  }
  if (cacheDatos.size > 24) cacheDatos.clear();
  cacheDatos.set(ruta, raices);
  return raices;
}

function nodoCon(raices, tiene) {
  for (const raiz of raices) {
    if (tiene(raiz)) return raiz;
  }
  return null;
}

// ---------------- ítems ----------------

function posterDe(id) {
  return id ? CDN + "/covers/" + id + ".jpg" : undefined;
}

function anioDe(fecha) {
  const m = String(fecha || "").match(/(\d{4})/);
  return m ? m[1] : undefined;
}

function itemDeResultado(r) {
  if (!r || !r.slug || !r.title) return null;
  const categoria = r.category && r.category.name ? r.category.name : "";
  const badges = [];
  if (categoria) badges.push(recortar(categoria, 20));
  if (r.status === "emision") badges.push("En emisión");
  if (badges.length > 3) badges.length = 3;
  return {
    id: String(r.slug),
    ref: "s:" + r.slug,
    title: recortar(r.title, 200),
    kind: "series",
    poster: posterDe(r.id),
    backdrop: r.id ? CDN + "/backdrops/" + r.id + ".jpg" : undefined,
    year: anioDe(r.startDate),
    overview: r.synopsis ? recortar(r.synopsis, 2000) : undefined,
    genres: Array.isArray(r.genres)
      ? r.genres.map((g) => recortar(g && g.name, 30)).filter(Boolean).slice(0, 5)
      : undefined,
    rating: typeof r.score === "number" ? Math.min(10, r.score) : undefined,
    lang: "es",
    badges: badges.length ? badges : undefined,
    adult: true,
  };
}

// ---------------- catálogo ----------------

// Lista páginas de /catalogo hasta llenar max (tope de Kino). Devuelve
// { items, siguiente } con siguiente = número de página para seguir.
async function paginarCatalogo(params, max, desdePagina) {
  const query = Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
  const items = [];
  const vistos = {};
  let pagina = desdePagina || 1;
  let ultimoLargo = 0;

  for (let n = 0; n < MAX_PAGINAS && items.length < max; n++) {
    // datosDeSvelte añade el sufijo __data.json él mismo
    const ruta = "/catalogo" + (query ? "?" + query : "") +
      (query ? "&" : "?") + "page=" + pagina;
    let raiz;
    try {
      const raices = await datosDeSvelte(ruta);
      raiz = nodoCon(raices, (r) => Array.isArray(r.results));
    } catch (e) {
      if (esKinoError(e) && n === 0) throw e;
      break;
    }
    const resultados = raiz ? raiz.results : [];
    ultimoLargo = resultados.length;
    let nuevos = 0;
    for (const r of resultados) {
      const item = itemDeResultado(r);
      if (!item || vistos[item.id]) continue;
      vistos[item.id] = 1;
      nuevos++;
      items.push(item);
      if (items.length >= max) break;
    }
    if (!resultados.length || !nuevos) {
      // sin resultados o página repetida (el sitio ignoró el page=): no hay más
      if (!nuevos) ultimoLargo = 0;
      break;
    }
    pagina++;
  }

  const hayMas = items.length >= max || ultimoLargo > 0;
  return {
    items,
    siguiente: hayMas && items.length ? String(pagina) : undefined,
  };
}

async function filaCatalogo(id, titulo, ref, params, max) {
  const r = await paginarCatalogo(params, max || MAX_FILA, 1);
  if (!r.items.length) return null;
  return { id, title: titulo, items: r.items, ref, genre: "anime" };
}

// Géneros que ofrece el sitio (del nodo del catálogo); si el nodo no los trae,
// una lista de respaldo de slugs conocidos.
const GENEROS_RESPALDO = [
  { name: "Vanilla", slug: "vanilla" },
  { name: "Tentáculos", slug: "tentaculos" },
  { name: "Yuri", slug: "yuri" },
  { name: "Enfermeras", slug: "enfermeras" },
  { name: "Ahegao", slug: "ahegao" },
  { name: "Harem", slug: "harem" },
  { name: "Escolares", slug: "escolares" },
  { name: "Tetonas", slug: "tetonas" },
];

// Yaoi se excluye por petición; Enfermeras se garantiza siempre.
function ajustarGeneros(gs) {
  const fuera = [];
  for (const g of gs) {
    if (!g || !g.slug || !g.name) continue;
    if (String(g.slug).toLowerCase() === "yaoi") continue; // sin sección Yaoi
    fuera.push(g);
  }
  if (!fuera.some((g) => String(g.slug).toLowerCase() === "enfermeras")) {
    fuera.push({ name: "Enfermeras", slug: "enfermeras" });
  }
  return fuera;
}

async function generosDelSitio() {
  try {
    const raices = await datosDeSvelte("/catalogo");
    for (const raiz of raices) {
      const gs = raiz && raiz.genres;
      if (Array.isArray(gs) && gs.length && gs[0] && gs[0].slug) {
        return ajustarGeneros(gs).slice(0, 24);
      }
    }
  } catch (e) {
    log("géneros:", String((e && e.message) || e));
  }
  return ajustarGeneros(GENEROS_RESPALDO);
}

// ---------------- búsqueda ----------------

function refDeUrl(texto) {
  let m = texto.match(/hentaila\.com\/media\/([a-z0-9-]+)/i);
  if (m) return "s:" + m[1];
  m = texto.match(/^s:([a-z0-9-]+)$/i);
  if (m) return "s:" + m[1].toLowerCase();
  return null;
}

export async function search(query) {
  const q = quitarEspacios(query.q || "");
  if (!q) return [];

  // URL o slug directo de una serie
  const refSerie = refDeUrl(q);
  if (refSerie) {
    try {
      const datos = await serieDeSlug(refSerie.slice(2));
      const item = itemDeResultado(datos.media);
      return item ? [item] : [];
    } catch (e) {
      log("serie por url:", String((e && e.message) || e));
    }
    return [];
  }

  const desde = query.cursor ? parseInt(query.cursor, 10) || 1 : 1;
  const r = await paginarCatalogo({ search: q }, MAX_BUSQUEDA, desde);
  return r.siguiente ? { items: r.items, next: r.siguiente } : r.items;
}

// ---------------- Inicio ----------------

const TITULOS_HUB = {
  trending: "Tendencias",
  popular: "Populares",
  popularity: "Populares",
  latest: "Más recientes",
  recent: "Recientes",
  newest: "Novedades",
  latestEpisodes: "Episodios recientes",
  recentEpisodes: "Episodios recientes",
  episodes: "Episodios recientes",
  all: "Todo el catálogo",
  catalog: "Catálogo",
  uncensored: "Sin censura",
  top: "Lo mejor",
};

function tituloDeClave(clave) {
  if (TITULOS_HUB[String(clave).toLowerCase()]) return TITULOS_HUB[String(clave).toLowerCase()];
  const b = quitarEspacios(String(clave));
  return b ? b.charAt(0).toUpperCase() + b.slice(1) : "Sección";
}

function numeroDeEpisodio(obj) {
  if (!obj || typeof obj !== "object") return 0;
  const ep = obj.episode && typeof obj.episode === "object" ? obj.episode : null;
  const n =
    (ep && (ep.number || ep.episode)) ||
    obj.number ||
    obj.episodeNumber ||
    obj.episode ||
    0;
  const x = parseInt(n, 10);
  return x > 0 ? x : 0;
}

// Convierte un objeto del hub (serie o episodio) en un ítem de Kino.
function itemDeHub(obj) {
  if (!obj || typeof obj !== "object") return null;
  const media = obj.media && typeof obj.media === "object" && obj.media.slug ? obj.media : obj;
  if (!media.slug || !media.title) return null;
  const item = itemDeResultado(media);
  if (!item) return null;
  const n = numeroDeEpisodio(obj);
  if (n) item.badges = ["Ep. " + n];
  return item;
}

// El Inicio del sitio ("/" o "/hub"): filas heurísticas a partir de las
// listas que traiga el nodo (series o episodios con slug).
async function filasDelHub() {
  const filas = [];
  const hechas = {};
  for (const ruta of ["/", "/hub"]) {
    let raices;
    try {
      raices = await datosDeSvelte(ruta);
    } catch (e) {
      continue;
    }
    for (const raiz of raices) {
      if (!raiz || typeof raiz !== "object") continue;
      for (const clave of Object.keys(raiz)) {
        if (filas.length >= 3) return filas;
        const lista = raiz[clave];
        if (!Array.isArray(lista) || !lista.length) continue;
        const muestra = lista.slice(0, 5);
        if (!muestra.every((x) => x && typeof x === "object")) continue;
        const items = [];
        const vistos = {};
        for (const obj of lista) {
          const item = itemDeHub(obj);
          if (!item || vistos[item.id]) continue;
          vistos[item.id] = 1;
          items.push(item);
          if (items.length >= MAX_FILA) break;
        }
        if (items.length >= 4) {
          const numero = numeroDeEpisodio(lista[0]);
          const id = "hub-" + String(clave).replace(/[^A-Za-z0-9-]/g, "").slice(0, 30) +
            (numero ? "-ep" : "");
          if (hechas[id]) continue; // "/" y "/hub" suelen traer lo mismo
          hechas[id] = 1;
          filas.push({
            id,
            title: tituloDeClave(clave),
            items,
            genre: "anime",
          });
        }
      }
    }
  }
  return filas;
}

export async function home() {
  const filas = [];

  try {
    for (const f of await filasDelHub()) filas.push(f);
  } catch (e) {
    log("hub:", String((e && e.message) || e));
  }

  const filasFijas = [
    { id: "populares", titulo: "Populares", ref: "cat:order=popular", params: { order: "popular" } },
    { id: "destacados", titulo: "Destacados de la semana", ref: "cat:order=score", params: { order: "score" } },
    { id: "estrenos", titulo: "Estrenos recientes", ref: "cat:order=latest_released", params: { order: "latest_released" } },
    { id: "emision", titulo: "En emisión", ref: "cat:status=emision", params: { status: "emision" } },
    { id: "sincensura", titulo: "Sin censura", ref: "cat:uncensored=1", params: { uncensored: "1" } },
  ];

  const hechas = await Promise.allSettled(
    filasFijas.map((f) => filaCatalogo(f.id, f.titulo, f.ref, f.params, MAX_FILA))
  );
  for (const h of hechas) {
    if (h.status === "fulfilled" && h.value) filas.push(h.value);
  }

  // Unas filas por género, si el sitio lista sus géneros
  try {
    const generos = (await generosDelSitio()).slice(0, 4);
    const hechasGenero = await Promise.allSettled(
      generos.map((g) =>
        filaCatalogo(
          "genero-" + g.slug,
          "Género: " + quitarEspacios(g.name),
          "cat:genre=" + g.slug,
          { genre: g.slug },
          MAX_FILA
        )
      )
    );
    for (const h of hechasGenero) {
      if (h.status === "fulfilled" && h.value) filas.push(h.value);
    }
  } catch (e) {
    log("filas de género:", String((e && e.message) || e));
  }

  if (!filas.length) {
    throw kino.error("unavailable", "no se pudo cargar el Inicio de hentaila.com");
  }
  return filas.slice(0, 20);
}

// ---------------- Categorías (pestaña Categorías) ----------------

export async function categories() {
  const out = [
    { id: "populares", title: "Populares", ref: "cat:order=popular" },
    { id: "destacados", title: "Destacados", ref: "cat:order=score" },
    { id: "estrenos", title: "Estrenos recientes", ref: "cat:order=latest_released" },
    { id: "emision", title: "En emisión", ref: "cat:status=emision" },
    { id: "finalizados", title: "Finalizados", ref: "cat:status=finalizado" },
    { id: "sincensura", title: "Sin censura", ref: "cat:uncensored=1" },
  ];
  try {
    const generos = await generosDelSitio();
    for (const g of generos) {
      out.push({
        id: "genero-" + g.slug,
        title: recortar(quitarEspacios(g.name), 40),
        ref: "cat:genre=" + g.slug,
      });
      if (out.length >= 24) break;
    }
  } catch (_) {}
  return out;
}

// ---------------- Ver más ----------------

export async function browse(ref, cursor) {
  if (typeof ref !== "string" || ref.indexOf("cat:") !== 0) {
    throw kino.error("not_found", "sección desconocida");
  }
  const query = ref.slice(4);
  const params = {};
  for (const parte of query.split("&")) {
    const i = parte.indexOf("=");
    if (i > 0) params[parte.slice(0, i)] = decodeURIComponent(parte.slice(i + 1));
    else params[parte] = "";
  }
  const pagina = cursor ? parseInt(cursor, 10) || 1 : 1;
  const r = await paginarCatalogo(params, MAX_VER_MAS, pagina);
  return { items: r.items, next: r.siguiente };
}

// ---------------- episodios ----------------

const cacheSeries = new Map(); // slug → { media, episodios }

async function serieDeSlug(slug) {
  if (cacheSeries.has(slug)) return cacheSeries.get(slug);
  const raices = await datosDeSvelte("/media/" + encodeURIComponent(slug));
  const nodo = nodoCon(raices, (r) => r && r.media && r.media.slug);
  if (!nodo) {
    throw kino.error("not_found", "serie no encontrada", {
      userMessage: "Esta serie ya no está en Hentaila.",
    });
  }
  const media = nodo.media;
  const episodios = (Array.isArray(media.episodes) ? media.episodes : [])
    .filter((e) => e && parseInt(e.number, 10) > 0)
    .map((e) => parseInt(e.number, 10))
    .sort((a, b) => a - b);
  const datos = { media, episodios };
  if (cacheSeries.size > 12) cacheSeries.clear();
  cacheSeries.set(slug, datos);
  return datos;
}

async function episodiosDeSerie(ref) {
  const slug = ref.slice(2);
  const { media, episodios } = await serieDeSlug(slug);
  const info = {
    title: recortar(media.title, 200),
    poster: posterDe(media.id),
    backdrop: media.id ? CDN + "/backdrops/" + media.id + ".jpg" : undefined,
    overview: media.synopsis ? recortar(media.synopsis, 2000) : undefined,
    year: anioDe(media.startDate),
    rating: typeof media.score === "number" ? Math.min(10, media.score) : undefined,
    genres: Array.isArray(media.genres)
      ? media.genres.map((g) => recortar(g && g.name, 30)).filter(Boolean).slice(0, 5)
      : undefined,
  };
  if (media.malId) info.ids = { mal: parseInt(media.malId, 10) || undefined };
  const caps = episodios.map((n) => ({
    season: 1,
    number: n,
    ref: "e:" + slug + ":" + n,
    title: "Episodio " + n,
    still: media.id ? CDN + "/screenshots/" + media.id + "/" + n + ".jpg" : undefined,
  }));
  return { series: info, episodes: caps };
}

export async function episodes(ref) {
  if (typeof ref === "string" && ref.indexOf("s:") === 0) {
    return await episodiosDeSerie(ref);
  }
  throw kino.error("not_found", "referencia desconocida");
}

// ---------------- resolve (embeds → vídeo) ----------------

function varianteDe(clave) {
  const k = String(clave).toLowerCase();
  if (/dub|lat|cast|esp/.test(k)) return "DUB";
  return "SUB";
}

// Episodio: { variantes: [{variante, servidor, url}], nodo }
async function episodioDeSlugNumero(slug, numero) {
  const raices = await datosDeSvelte(
    "/media/" + encodeURIComponent(slug) + "/" + encodeURIComponent(String(numero))
  );
  const nodo = nodoCon(
    raices,
    (r) =>
      r &&
      (r.embeds || r.downloads || (r.episode && (r.episode.embeds || r.episode.downloads)))
  );
  if (!nodo) {
    throw kino.error("not_found", "episodio sin servidores", {
      userMessage: "Este episodio no tiene servidores disponibles.",
    });
  }
  const dato = nodo.episode && (nodo.episode.embeds || nodo.episode.downloads) ? nodo.episode : nodo;
  return { nodo, dato };
}

function juntarServidores(dato) {
  const out = [];
  const vistos = {};
  const sumar = (mapa, esDescarga) => {
    if (!mapa || typeof mapa !== "object") return;
    const pares = [];
    if (Array.isArray(mapa)) {
      // lista directa de {server,url}
      for (const e of mapa) {
        pares.push([varianteDe(e && (e.lang || e.variant || e.type)), e]);
      }
    } else {
      // mapa de variante → lista de embeds
      for (const clave of Object.keys(mapa)) {
        const lista = mapa[clave];
        if (!Array.isArray(lista)) continue;
        for (const e of lista) pares.push([varianteDe(clave), e]);
      }
    }
    for (const par of pares) {
      const e = par[1];
      if (!e || !e.url) continue;
      const url = String(e.url);
      if (vistos[url]) continue;
      vistos[url] = 1;
      out.push({
        variante: par[0],
        servidor: quitarEspacios(e.server) || "Servidor",
        url,
        descarga: !!esDescarga,
      });
    }
  };
  sumar(dato.embeds, false);
  sumar(dato.downloads, true); // enlaces de descarga directos (.mp4) también sirven
  return out;
}

// Clave del ajuste "servidor" a partir del nombre que muestra el sitio
// (p. ej. "Voe" → "voe", "Streamtape" → "streamtape").
function claveServidor(nombre) {
  const k = String(nombre || "").toLowerCase();
  if (k.indexOf("voe") !== -1) return "voe";
  if (k.indexOf("mp4upload") !== -1) return "mp4upload";
  if (k.indexOf("streamtape") !== -1 || k.indexOf("streamta") !== -1) return "streamtape";
  if (k.indexOf("yourupload") !== -1) return "yourupload";
  if (k.indexOf("sendvid") !== -1) return "sendvid";
  return "";
}

function ordenarServidores(lista) {
  const preferida = String(cfg("idioma", "SUB")).toUpperCase() === "DUB" ? "DUB" : "SUB";
  const servidorPreferido = String(cfg("servidor", "voe")).toLowerCase();
  const puntuacion = (s) => {
    let p = 0;
    if (s.variante === preferida) p += 100;
    if (s.descarga) p -= 10; // los embeds primero
    // el ajuste "Servidor preferido" manda sobre el idioma
    if (
      servidorPreferido &&
      servidorPreferido !== "auto" &&
      claveServidor(s.servidor) === servidorPreferido
    ) {
      p += 1000;
    }
    const k = s.servidor.toLowerCase();
    if (k.indexOf("voe") !== -1) p += 5;
    if (k.indexOf("mp4upload") !== -1) p += 4;
    if (k.indexOf("streamtape") !== -1 || k.indexOf("streamta") !== -1) p += 3;
    if (k.indexOf("yourupload") !== -1) p += 2;
    if (k.indexOf("sendvid") !== -1) p += 1;
    return p;
  };
  return lista.slice().sort((a, b) => puntuacion(b) - puntuacion(a));
}

// --- desempaquetador de scripts "eval(function(p,a,c,k,e,d){…})" ---

// base 2–62 (Number.toString solo llega a 36 y los packers usan hasta 62)
function enBase(n, a) {
  const digitos = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (!n) return "0";
  if (a <= 36) return n.toString(a);
  let s = "";
  while (n > 0) {
    s = digitos.charAt(n % a) + s;
    n = Math.floor(n / a);
  }
  return s;
}

function desempaquetar(html) {
  const m = html.match(
    /'([^']*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'\.split\('\|'\)/
  );
  if (!m) return null;
  let carga = m[1];
  const a = parseInt(m[2], 10);
  let c = parseInt(m[3], 10);
  const palabras = m[4].split("|");
  carga = carga.replace(/\\x([0-9A-Fa-f]{2})/g, function (_, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  while (c--) {
    const clave = enBase(c, a);
    const re = new RegExp("\\b" + clave + "\\b", "g");
    carga = carga.replace(re, function () {
      return palabras[c] || clave;
    });
  }
  return carga;
}

const RE_MP4_O_M3U8 = /\.(mp4|m3u8)(?:\?|$|#)/i;

async function extraerDePagina(url, html) {
  const scripts = [];
  for (const m of scan(/<script[^>]*>([\s\S]*?)<\/script>/gi, html)) {
    if (m[1]) scripts.push(m[1]);
  }

  const patrones = [
    /player\.src\(\s*["']([^"']+)["']/i,
    /player\.src\(\s*src\s*:\s*["']([^"']+)["']/i,
    /sources\s*:\s*\[\s*\{\s*(?:file|src)\s*:\s*["']([^"']+)["']/i,
    /["'](?:file|src|url|source)["']\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
    /video_source\s*=\s*["']([^"']+)["']/i,
    /(?:file|src)\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
  ];

  // primero los scripts desempaquetados (p,a,c,k,e,d), luego los normales
  const orden = [];
  for (const s of scripts) {
    if (s.indexOf("p,a,c,k,e,d") !== -1) {
      const d = desempaquetar(s);
      if (d) orden.push(d);
    }
  }
  for (const s of scripts) orden.push(s);
  orden.push(html);

  for (const texto of orden) {
    for (const re of patrones) {
      const m = texto.match(re);
      if (m && m[1] && /^https?:\/\//i.test(m[1])) return m[1];
    }
  }
  return null;
}

// Streamtape: la página arma el enlace final con un substring; se construye
// el get_video y el reproductor sigue su redirección (streamHosts: any).
async function resolverStreamtape(url, html) {
  let m = html.match(
    /botlink'\)\.innerHTML\s*=\s*'([^']*)'\s*\+\s*\('([^']*)'\)\.substring\((\d+)\)/
  );
  if (m) {
    const params = m[2].substring(parseInt(m[3], 10));
    const base = /^https?:\/\//i.test(m[1]) ? m[1] : "https://" + hostDe(url) + "/get_video?";
    return base + params;
  }
  m = html.match(/getElementById\(['"]videolink['"][^"']*["']([^"']*get_video[^"']*)["']/);
  if (m) return m[1].replace(/&amp;/g, "&");
  m = html.match(/["']([^"']*get_video\?[^"']*)["']/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

async function resolverEmbed(entrada, referer) {
  const url = entrada.url;
  const host = hostDe(url);

  // enlace directo
  if (RE_MP4_O_M3U8.test(url)) {
    return {
      url,
      mime: /\.m3u8/i.test(url) ? "application/x-mpegURL" : "video/mp4",
      headers: { Referer: referer },
    };
  }

  let html;
  try {
    html = await bajarTexto(url, { headers: encabezados({ Referer: referer }) });
  } catch (e) {
    if (esKinoError(e)) log("embed " + host + ":", e.message);
    return null;
  }

  let directa = null;
  if (/streamtape|streamta|stape/i.test(host)) {
    directa = await resolverStreamtape(url, html);
  }
  if (!directa) directa = await extraerDePagina(url, html);

  // última opción: navegador oculto (el manifiesto declara "browser": true)
  if (!directa && typeof kino.browser !== "undefined" && typeof kino.browser.capture === "function") {
    try {
      const cap = await kino.browser.capture(url, {
        headers: { Referer: referer, "User-Agent": UA },
      });
      const medio = cap && cap.media && cap.media[0];
      if (medio && medio.url) {
        return {
          url: medio.url,
          mime: medio.mime || "video/mp4",
          headers: Object.assign({ Referer: originDe(url) }, medio.headers || {}),
        };
      }
    } catch (e) {
      log("browser " + host + ":", String((e && e.message) || e));
    }
    return null;
  }
  if (!directa) return null;

  let final = directa.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  if (final.indexOf("//") === 0) final = "https:" + final;
  return {
    url: final,
    mime: /\.m3u8/i.test(final) ? "application/x-mpegURL" : "video/mp4",
    headers: { Referer: "https://" + host + "/" },
  };
}

function etiqueta(entrada) {
  return recortar(entrada.variante + " · " + entrada.servidor, 48);
}

export async function resolve(ref) {
  if (typeof ref !== "string" || ref.indexOf("e:") !== 0) {
    throw kino.error("not_found", "referencia desconocida");
  }
  const resto = ref.slice(2);
  const corte = resto.indexOf("|");
  const base = corte === -1 ? resto : resto.slice(0, corte);
  const indice = corte === -1 ? -1 : parseInt(resto.slice(corte + 1), 10);
  const partes = base.split(":");
  const slug = partes[0];
  const numero = parseInt(partes[1], 10);
  if (!slug || !(numero > 0)) {
    throw kino.error("not_found", "referencia de episodio inválida");
  }

  const { dato } = await episodioDeSlugNumero(slug, numero);
  const lista = ordenarServidores(juntarServidores(dato)).filter(
    (s) => !s.descarga || RE_MP4_O_M3U8.test(s.url)
  );
  if (!lista.length) {
    throw kino.error("not_found", "episodio sin servidores", {
      userMessage: "Este episodio no tiene servidores disponibles.",
    });
  }

  // Una copia perezosa: solo ese servidor
  if (indice >= 0) {
    const elegida = lista[indice];
    if (!elegida) {
      throw kino.error("not_found", "esa copia ya no está", {
        userMessage: "Esa copia ya no está disponible; prueba otra.",
      });
    }
    const stream = await resolverEmbed(elegida, HOST + "/media/" + slug);
    if (!stream) {
      throw kino.error("unavailable", "el servidor no respondió", {
        userMessage: "Ese servidor no respondió. Prueba con otra copia.",
      });
    }
    stream.label = etiqueta(elegida);
    return stream;
  }

  const intentos = Math.min(lista.length, 5);
  for (let i = 0; i < intentos; i++) {
    let stream = null;
    try {
      stream = await resolverEmbed(lista[i], HOST + "/media/" + slug);
    } catch (e) {
      if (esKinoError(e) && e.name.indexOf("KinoError_rate_limited") === 0) throw e;
      continue;
    }
    if (!stream) continue;
    stream.label = etiqueta(lista[i]);

    const alternativas = [];
    for (let j = 0; j < lista.length && alternativas.length < 8; j++) {
      if (j === i || j >= intentos) continue; // solo las que de verdad existen
      alternativas.push({
        label: etiqueta(lista[j]),
        ref: "e:" + slug + ":" + numero + "|" + j,
      });
    }
    if (alternativas.length) stream.alternatives = alternativas;
    return stream;
  }

  throw kino.error("unavailable", "ningún servidor dio vídeo", {
    userMessage: "Ningún servidor respondió. Prueba de nuevo más tarde.",
  });
}
