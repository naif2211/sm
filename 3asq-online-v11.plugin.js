const BASE = "https://3asq.online";

function abs(url) {
  if (!url) return undefined;
  try {
    const u = new URL(String(url).trim(), BASE);
    if (!/^https?:$/i.test(u.protocol)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function path(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url).trim(), BASE);
    return u.pathname.replace(/^\/+|\/+$/g, "") + (u.search || "");
  } catch {
    return "";
  }
}

async function doc(p) {
  const r = await harbor.http(BASE + p, { responseType: "text" });
  return r.ok ? harbor.parseHtml(r.body) : null;
}

async function postText(url, body) {
  try {
    const r = await harbor.http(url, {
      method: "POST",
      responseType: "text",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE + "/",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: body || "",
    });
    return r.ok ? (r.body || "") : "";
  } catch {
    return "";
  }
}

function text(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const value = el ? (el.text() || "").trim() : "";
    if (value) return value;
  }
  return "";
}

function meta(doc, names) {
  const wanted = names.map((x) => x.toLowerCase());
  for (const m of doc.querySelectorAll("meta")) {
    const key = ((m.attr("property") || m.attr("name") || "") + "").toLowerCase();
    if (wanted.includes(key)) return (m.attr("content") || "").trim();
  }
  return "";
}

function img(image) {
  if (!image) return undefined;
  return abs(
    image.attr("data-src") ||
      image.attr("data-lazy-src") ||
      image.attr("data-original") ||
      image.attr("data-lazy") ||
      image.attr("src")
  );
}

function cover(doc) {
  const m = meta(doc, ["og:image", "twitter:image", "twitter:image:src"]);
  if (m) return abs(m);

  for (const selector of [
    ".summary_image img",
    ".summary-image img",
    ".summary_image a img",
    ".post-thumbnail img",
    ".tab-summary .summary_image img",
  ]) {
    const u = img(doc.querySelector(selector));
    if (u) return u;
  }

  return undefined;
}

function isChapterLink(href) {
  return (
    /\/manga\/[^/]+\/\d+(?:\.\d+)?\/?(?:\?.*)?$/i.test(href) ||
    /chapter[\s._-]*\d+/i.test(href)
  );
}

function chapterNumber(title, href) {
  const source = `${title || ""} ${href || ""}`;
  const patterns = [
    /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
    /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
    /\/([0-9]+(?:\.[0-9]+)?)\/?(?:\?.*)?$/,
    /(?:الفصل|فصل)[\s._:-]*(\d+(?:\.\d+)?)/i,
  ];

  for (const regex of patterns) {
    const match = source.match(regex);
    if (match) return match[1];
  }

  return null;
}

function chapterListFromDoc(root) {
  const out = [];
  const seen = new Set();

  const add = (a) => {
    const href = a.attr("href") || "";
    if (!href) return;

    const title = (a.text() || a.attr("title") || "").trim();
    const number = chapterNumber(title, href);
    if (!number) return;

    const id = path(href);
    if (!id || seen.has(id) || !isChapterLink(href)) return;

    seen.add(id);
    out.push({
      id,
      chapter: number,
      title: title || `الفصل ${number}`,
      volume: a.attr("data-volume") || a.attr("data-vol") || null,
      pages: 0,
      // Harbor filters by this value; 3asq is still the Arabic source.
      language: "en",
      publishAt: undefined,
    });
  };

  for (const selector of [
    "li.wp-manga-chapter a",
    ".wp-manga-chapter a",
    ".wp-manga-chapters a",
    ".chapter-list a",
    ".version-chap a",
    ".listing-chapters_wrap a",
    ".chapter-item a",
  ]) {
    for (const a of root.querySelectorAll(selector)) add(a);
  }

  // Some 3asq pages expose chapter links directly without the li wrapper.
  for (const a of root.querySelectorAll('a[href*="/manga/"]')) add(a);

  out.sort((a, b) => {
    const na = parseFloat(a.chapter);
    const nb = parseFloat(b.chapter);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
    return 0;
  });

  return out;
}

function findMangaId(doc) {
  const selectors = [
    "[id^='manga-chapters-holder']",
    "[data-id][class*='chapter']",
    ".listing-chapters_wrap[data-id]",
    ".c-tabs-item__content[data-id]",
    "[data-post-id]",
  ];

  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (!el) continue;

    for (const attr of ["data-id", "data-post-id", "data-manga-id", "data-manga_id"]) {
      const value = el.attr(attr);
      if (value && /^\d+$/.test(value)) return value;
    }
  }

  return null;
}

async function fetchMadaraChapters(mangaPath, mangaId, originalDoc) {
  const cleanPath = String(mangaPath || "").replace(/^\/+|\/+$/g, "");
  const cleanId = mangaId ? String(mangaId).trim() : "";

  // New Madara chapter endpoint. It returns the whole chapter list HTML.
  if (cleanPath) {
    const body = await postText(BASE + "/" + cleanPath + "/ajax/chapters", "");
    if (body) {
      const parsed = harbor.parseHtml(body);
      const result = chapterListFromDoc(parsed);
      if (result.length) return result;
    }
  }

  // Classic Madara endpoint. It needs the numeric manga ID.
  if (cleanId) {
    const form = "action=manga_get_chapters&manga=" + encodeURIComponent(cleanId);
    const body = await postText(BASE + "/wp-admin/admin-ajax.php", form);
    if (body) {
      const parsed = harbor.parseHtml(body);
      const result = chapterListFromDoc(parsed);
      if (result.length) return result;
    }
  }

  // Final fallback: whatever the original document exposes.
  return originalDoc ? chapterListFromDoc(originalDoc) : [];
}

function summaries(doc) {
  const out = [];
  const seen = new Set();

  for (const selector of [
    ".page-item-detail",
    ".c-tabs-item__content .page-item-detail",
    ".bsx",
    ".manga-item",
    "article",
  ]) {
    for (const card of doc.querySelectorAll(selector)) {
      let link = null;

      for (const a of card.querySelectorAll("a")) {
        const href = a.attr("href") || "";
        if (/\/manga\//i.test(href) && !isChapterLink(href)) {
          link = a;
          break;
        }
      }

      if (!link) continue;

      const id = path(link.attr("href") || "");
      const title = (
        link.attr("title") ||
        link.text() ||
        text(card, ["h2", "h3", ".title"]) ||
        ""
      ).trim();

      if (!id || !title || seen.has(id)) continue;

      seen.add(id);
      out.push({
        id,
        title,
        cover: img(card.querySelector("img") || link.querySelector("img")),
      });
    }
  }

  if (!out.length) {
    for (const a of doc.querySelectorAll('a[href*="/manga/"]')) {
      const href = a.attr("href") || "";
      if (isChapterLink(href)) continue;

      const id = path(href);
      const title = (a.attr("title") || a.text() || "").trim();
      if (!id || !title || seen.has(id)) continue;

      seen.add(id);
      out.push({
        id,
        title,
        cover: img(a.querySelector("img")),
      });
    }
  }

  return out;
}

function listingPaths(kind, page, query, tagId) {
  const q = encodeURIComponent(query || "");
  const t = tagId ? encodeURIComponent(tagId) : "";

  if (kind === "popular") {
    if (tagId) {
      return [
        `/manga-genre/${t}/?m_orderby=views&page=${page}`,
        `/genre/${t}/?m_orderby=views&page=${page}`,
        `/manga/?m_orderby=views&genre=${t}&page=${page}`,
      ];
    }

    return [
      `/manga/?m_orderby=views&page=${page}`,
      `/manga/page/${page}/?m_orderby=views`,
    ];
  }

  if (tagId) {
    return [
      `/manga-genre/${t}/?s=${q}&post_type=wp-manga&page=${page}`,
      `/genre/${t}/?s=${q}&post_type=wp-manga&page=${page}`,
      `/manga/?s=${q}&post_type=wp-manga&genre=${t}&page=${page}`,
    ];
  }

  return [
    `/manga/?s=${q}&post_type=wp-manga&page=${page}`,
    `/?s=${q}&post_type=wp-manga&page=${page}`,
  ];
}

async function listing(paths) {
  for (const p of paths) {
    const d = await doc(p);
    if (!d) continue;
    const result = summaries(d);
    if (result.length) return result;
  }
  return [];
}

async function pageUrlsFor(id) {
  const clean = String(id).replace(/^\/+/, "");
  const d = await doc("/" + clean);
  const out = [];
  const seen = new Set();

  if (d) {
    for (const selector of [
      ".reading-content img",
      "#readerarea img",
      ".page-break img",
      ".entry-content .page-break img",
      ".wp-manga-chapter-img img",
      ".manga-chapter img",
    ]) {
      for (const i of d.querySelectorAll(selector)) {
        const u = img(i);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      }
    }
  }

  return out;
}

const plugin = {
  id: "3asq-online",
  name: "3asq.online",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    return await listing(listingPaths("popular", page, "", tagId));
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    return await listing(listingPaths("search", page, query, tagId));
  },

  async detail(id) {
    const clean = String(id).replace(/^\/+/, "");
    const d = await doc("/" + clean);
    if (!d) return null;

    const yearText = text(d, [
      ".year",
      ".release-year",
      ".summary-content.year",
      ".post-content_item.manga-release .summary-content",
    ]);
    const yearMatch = yearText.match(/\b(19\d{2}|20\d{2})\b/);

    return {
      id,
      title:
        text(d, [".post-title h1", ".summary-title h1", "h1.entry-title", "h1"]) ||
        meta(d, ["og:title", "twitter:title"]) ||
        id,
      altTitle: text(d, [
        ".alternative",
        ".alt-title",
        ".summary-content.alt",
        ".post-content_item.manga-alternative .summary-content",
      ]) || undefined,
      cover: cover(d),
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      status:
        text(d, [
          ".post-status .summary-content",
          ".summary-content.status",
          ".post-content_item.manga-status .summary-content",
        ]) || undefined,
      description:
        meta(d, ["og:description", "twitter:description", "description"]) ||
        text(d, [
          ".summary__content",
          ".summary_content",
          ".summary-content",
          ".description-summary",
        ]),
      lastChapter:
        text(d, [
          ".wp-manga-chapter a",
          ".wp-manga-chapters a",
          ".chapter-list a",
        ]) || undefined,
      author:
        text(d, [
          ".author-content",
          ".author",
          ".summary-content.author",
          ".post-content_item.manga-authors .summary-content",
        ]) || undefined,
    };
  },

  async chapters(id) {
    const mangaPath = String(id).replace(/^\/+/, "");
    const d = await doc("/" + mangaPath);
    if (!d) return [];

    const mangaId = findMangaId(d);
    return await fetchMadaraChapters(mangaPath, mangaId, d);
  },

  async pageUrls(chapterId) {
    return await pageUrlsFor(chapterId);
  },

  async tags() {
    const out = [];
    const seen = new Set();

    for (const p of ["/manga-genre/", "/genre/", "/genres/", "/"]) {
      const d = await doc(p);
      if (!d) continue;

      for (const a of d.querySelectorAll(
        'a[href*="/manga-genre/"],a[href*="/genre/"],a[href*="/genres/"]'
      )) {
        const href = a.attr("href") || "";
        const id = path(href)
          .replace(/^(manga-genre|genre|genres)\//i, "")
          .replace(/^\/+|\/+$/g, "");
        const name = (a.text() || "").trim();

        if (!id || !name || seen.has(id)) continue;

        seen.add(id);
        out.push({ id, name, group: "Genre" });
      }
    }

    return out;
  },
};

harbor.register(plugin);
