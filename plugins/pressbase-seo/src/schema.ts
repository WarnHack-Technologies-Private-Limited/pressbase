/**
 * The JSON-LD graph: one `@graph` with stable `@id`s, in the shape Yoast SEO
 * prints, so search engines (and tools built for Yoast's graph) read it the
 * same way:
 *
 * - `{home}/#organization` or `{home}/#/schema/person/{id}`: who the site represents
 * - `{home}/#website`: the site, with a SearchAction
 * - `{url}#webpage`: the page (WebPage, CollectionPage, ProfilePage, SearchResultsPage)
 * - `{url}#primaryimage`: its main image
 * - `{url}#breadcrumb`: the BreadcrumbList
 * - `{url}#article`: posts only, with the author as a Person
 *
 * Pure: the caller gathers the data (head.ts) and filters the result
 * (`pressbase_seo_schema_graph`).
 */

export type GraphNode = Record<string, unknown> & { '@type': string | string[]; '@id'?: string };

export interface SchemaImage {
  url: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface SchemaInput {
  home: string;
  siteName: string;
  siteDescription: string;
  /** BCP 47, e.g. en-US. */
  language: string;
  representation:
    | { type: 'company'; name: string; logo?: SchemaImage; sameAs: string[] }
    | { type: 'person'; id: number; name: string; image?: SchemaImage; sameAs: string[] }
    | null;
  page: {
    url: string;
    type: 'WebPage' | 'CollectionPage' | 'ProfilePage' | 'SearchResultsPage';
    name: string;
    description?: string;
    datePublished?: string;
    dateModified?: string;
    image?: SchemaImage;
  };
  breadcrumbs: { name: string; url?: string }[];
  article?: {
    headline: string;
    datePublished: string;
    dateModified: string;
    author?: { id: number; name: string; url?: string };
    sections: string[];
    keywords: string[];
    wordCount?: number;
  };
  /** ProfilePage: the person the page is about. */
  profile?: { id: number; name: string; url?: string; description?: string };
}

export const ids = {
  organization: (home: string) => `${home}/#organization`,
  website: (home: string) => `${home}/#website`,
  person: (home: string, id: number) => `${home}/#/schema/person/${id}`,
  logo: (home: string) => `${home}/#/schema/logo/image/`,
  webpage: (url: string) => `${url}#webpage`,
  image: (url: string) => `${url}#primaryimage`,
  breadcrumb: (url: string) => `${url}#breadcrumb`,
  article: (url: string) => `${url}#article`,
};

function imageObject(id: string, image: SchemaImage, language: string): GraphNode {
  return {
    '@type': 'ImageObject',
    '@id': id,
    inLanguage: language,
    url: image.url,
    contentUrl: image.url,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    ...(image.caption ? { caption: image.caption } : {}),
  };
}

export function buildGraph(input: SchemaInput): GraphNode[] {
  const { home, language, page } = input;
  const graph: GraphNode[] = [];
  const rep = input.representation;
  const publisherId = rep
    ? rep.type === 'company'
      ? ids.organization(home)
      : ids.person(home, rep.id)
    : undefined;
  const hasImage = Boolean(page.image?.url);
  const hasCrumbs = input.breadcrumbs.length > 0;

  if (input.article) {
    const a = input.article;
    graph.push({
      '@type': 'Article',
      '@id': ids.article(page.url),
      isPartOf: { '@id': ids.webpage(page.url) },
      ...(a.author
        ? { author: { name: a.author.name, '@id': ids.person(home, a.author.id) } }
        : {}),
      headline: a.headline.slice(0, 110),
      datePublished: a.datePublished,
      dateModified: a.dateModified,
      mainEntityOfPage: { '@id': ids.webpage(page.url) },
      ...(a.wordCount ? { wordCount: a.wordCount } : {}),
      ...(publisherId ? { publisher: { '@id': publisherId } } : {}),
      ...(hasImage
        ? { image: { '@id': ids.image(page.url) }, thumbnailUrl: page.image?.url }
        : {}),
      ...(a.keywords.length ? { keywords: a.keywords } : {}),
      ...(a.sections.length ? { articleSection: a.sections } : {}),
      inLanguage: language,
    });
  }

  graph.push({
    '@type': page.type,
    '@id': ids.webpage(page.url),
    url: page.url,
    name: page.name,
    isPartOf: { '@id': ids.website(home) },
    ...(hasImage
      ? {
          primaryImageOfPage: { '@id': ids.image(page.url) },
          image: { '@id': ids.image(page.url) },
          thumbnailUrl: page.image?.url,
        }
      : {}),
    ...(page.datePublished ? { datePublished: page.datePublished } : {}),
    ...(page.dateModified ? { dateModified: page.dateModified } : {}),
    ...(page.description ? { description: page.description } : {}),
    ...(hasCrumbs ? { breadcrumb: { '@id': ids.breadcrumb(page.url) } } : {}),
    ...(input.profile ? { mainEntity: { '@id': ids.person(home, input.profile.id) } } : {}),
    inLanguage: language,
    ...(page.type === 'WebPage'
      ? { potentialAction: [{ '@type': 'ReadAction', target: [page.url] }] }
      : {}),
  });

  if (hasImage && page.image) graph.push(imageObject(ids.image(page.url), page.image, language));

  if (hasCrumbs) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': ids.breadcrumb(page.url),
      itemListElement: input.breadcrumbs.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
        // Google wants `item` on every crumb but the last.
        ...(crumb.url && index < input.breadcrumbs.length - 1 ? { item: crumb.url } : {}),
      })),
    });
  }

  graph.push({
    '@type': 'WebSite',
    '@id': ids.website(home),
    url: `${home}/`,
    name: input.siteName,
    ...(input.siteDescription ? { description: input.siteDescription } : {}),
    ...(publisherId ? { publisher: { '@id': publisherId } } : {}),
    potentialAction: [
      {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${home}/?s={search_term_string}` },
        'query-input': {
          '@type': 'PropertyValueSpecification',
          valueRequired: true,
          valueName: 'search_term_string',
        },
      },
    ],
    inLanguage: language,
  });

  if (rep?.type === 'company' && rep.name) {
    graph.push({
      '@type': 'Organization',
      '@id': ids.organization(home),
      name: rep.name,
      url: `${home}/`,
      ...(rep.logo?.url
        ? {
            logo: imageObject(ids.logo(home), { caption: rep.name, ...rep.logo }, language),
            image: { '@id': ids.logo(home) },
          }
        : {}),
      ...(rep.sameAs.length ? { sameAs: rep.sameAs } : {}),
    });
  }

  // People: the site's person, the article's author and the profile page's subject, once each.
  const people = new Map<number, GraphNode>();
  if (rep?.type === 'person' && rep.name) {
    people.set(rep.id, {
      '@type': ['Person', 'Organization'],
      '@id': ids.person(home, rep.id),
      name: rep.name,
      ...(rep.image?.url
        ? {
            image: imageObject(ids.logo(home), { caption: rep.name, ...rep.image }, language),
            logo: { '@id': ids.logo(home) },
          }
        : {}),
      ...(rep.sameAs.length ? { sameAs: rep.sameAs } : {}),
    });
  }
  for (const person of [input.article?.author, input.profile]) {
    if (!person || people.has(person.id)) continue;
    people.set(person.id, {
      '@type': 'Person',
      '@id': ids.person(home, person.id),
      name: person.name,
      ...('description' in person && person.description
        ? { description: person.description }
        : {}),
      ...(person.url ? { url: person.url } : {}),
    });
  }
  graph.push(...people.values());
  return graph;
}
