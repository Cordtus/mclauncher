/**
 * Mojang API Integration Service
 *
 * Provides username to UUID resolution for whitelist and operator management.
 * Implements rate limiting and caching to comply with Mojang API limits.
 */

interface MojangProfile {
  id: string;
  name: string;
}

interface PlayerProfile {
  uuid: string;
  name: string;
}

/**
 * In-memory cache for UUID lookups to avoid hitting rate limits
 * Cache expires after 1 hour
 */
const uuidCache = new Map<string, { profile: PlayerProfile; expires: number }>();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Rate limiting - Mojang allows approximately 600 requests per 10 minutes
 * We'll be conservative and limit to 10 requests per minute
 */
let requestCount = 0;
let rateLimitWindow = Date.now();
const MAX_REQUESTS_PER_MINUTE = 10;

/**
 * Resolves a Minecraft username to a UUID using the Mojang API
 *
 * @param username - The Minecraft username to resolve
 * @returns Promise resolving to player profile with UUID and name
 * @throws Error if username is invalid, rate limit exceeded, or API request fails
 */
export async function resolveUsername(username: string): Promise<PlayerProfile> {
  // Validate username format
  if (!username || typeof username !== 'string') {
    throw new Error('Invalid username: must be a non-empty string');
  }

  const cleanUsername = username.trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 16) {
    throw new Error('Invalid username: must be between 3 and 16 characters');
  }

  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    throw new Error('Invalid username: can only contain letters, numbers, and underscores');
  }

  // Check cache first
  const cached = uuidCache.get(cleanUsername.toLowerCase());
  if (cached && cached.expires > Date.now()) {
    return cached.profile;
  }

  // Rate limiting check
  const now = Date.now();
  if (now - rateLimitWindow > 60000) {
    // Reset window
    requestCount = 0;
    rateLimitWindow = now;
  }

  if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
  }

  // Make API request
  requestCount++;
  const apiUrl = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(cleanUsername)}`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'MC-LXD-Manager/1.0'
      }
    });

    if (response.status === 204 || response.status === 404) {
      throw new Error(`Player "${cleanUsername}" not found`);
    }

    if (response.status === 429) {
      throw new Error('Mojang API rate limit exceeded. Please try again later.');
    }

    if (!response.ok) {
      throw new Error(`Mojang API error: ${response.status} ${response.statusText}`);
    }

    const data: MojangProfile = await response.json();

    // Format UUID with dashes (Mojang returns without dashes)
    const formattedUuid = formatUuid(data.id);

    const profile: PlayerProfile = {
      uuid: formattedUuid,
      name: data.name
    };

    // Cache the result
    uuidCache.set(cleanUsername.toLowerCase(), {
      profile,
      expires: Date.now() + CACHE_DURATION
    });

    return profile;
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error('Failed to resolve username: Unknown error');
  }
}

/**
 * Formats a UUID string to include dashes in the standard format
 * Converts: 069a79f444e94726a5befca90e38aaf5
 * To: 069a79f4-44e9-4726-a5be-fca90e38aaf5
 *
 * @param uuid - UUID string without dashes
 * @returns Formatted UUID with dashes
 */
function formatUuid(uuid: string): string {
  if (uuid.includes('-')) return uuid; // Already formatted

  return [
    uuid.substring(0, 8),
    uuid.substring(8, 12),
    uuid.substring(12, 16),
    uuid.substring(16, 20),
    uuid.substring(20, 32)
  ].join('-');
}

/**
 * Resolves multiple usernames to UUIDs in batch
 * Implements sequential processing to respect rate limits
 *
 * @param usernames - Array of usernames to resolve
 * @returns Promise resolving to array of player profiles
 * @throws Error if any username resolution fails
 */
export async function resolveUsernames(usernames: string[]): Promise<PlayerProfile[]> {
  const profiles: PlayerProfile[] = [];

  for (const username of usernames) {
    const profile = await resolveUsername(username);
    profiles.push(profile);

    // Small delay between requests to be nice to Mojang's API
    if (profiles.length < usernames.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return profiles;
}

/**
 * Clears the UUID cache
 * Useful for testing or forcing fresh lookups
 */
export function clearCache(): void {
  uuidCache.clear();
  requestCount = 0;
  rateLimitWindow = Date.now();
}
