export function configFrom(env = {}) {
  return {
    site: env.SITE_DOMAIN || '',
    gaPropertyId: env.GA4_PROPERTY_ID || '',
    searchConsoleSite: env.SEARCH_CONSOLE_SITE || '',
    googleClientId: env.GOOGLE_CLIENT_ID || '', googleClientSecret: env.GOOGLE_CLIENT_SECRET || '', googleRefreshToken: env.GOOGLE_REFRESH_TOKEN || '',
    googleServiceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    cloudflareSiteTag: env.CLOUDFLARE_SITE_TAG || '',
    cloudflareToken: env.CLOUDFLARE_ANALYTICS_TOKEN || '',
    vercelProjectId: env.VERCEL_ANALYTICS_PROJECT_ID || '',
    vercelTeamId: env.VERCEL_ANALYTICS_TEAM_ID || '',
    vercelToken: env.VERCEL_ANALYTICS_TOKEN || '',
    bingSite: env.BING_SITE || '', bingApiKey: env.BING_WEBMASTER_API_KEY || '',
  };
}
