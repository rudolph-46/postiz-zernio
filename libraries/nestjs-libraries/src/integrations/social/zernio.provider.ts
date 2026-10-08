import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { Integration } from '@prisma/client';

const ZERNIO_API = 'https://zernio.com/api/v1';

// Zernio owns the OAuth apps (Meta, TikTok, Google...), so a channel connected
// through it has no token of its own: the "access token" stored by Postiz is
// the Zernio account id, and the API key lives in ZERNIO_API_KEY.
export abstract class ZernioProvider
  extends SocialAbstract
  implements SocialProvider
{
  abstract platform: string; // Zernio platform value, e.g. "twitter"
  abstract identifier: string;
  abstract name: string;
  abstract maxLength(): number;

  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  override maxConcurrentJob = 5;

  private headers() {
    return {
      Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  private async profileId(): Promise<string> {
    if (process.env.ZERNIO_PROFILE_ID) {
      return process.env.ZERNIO_PROFILE_ID;
    }

    const { profiles } = await (
      await this.fetch(`${ZERNIO_API}/profiles`, { headers: this.headers() })
    ).json();

    if (profiles?.[0]?._id) {
      return profiles[0]._id;
    }

    const { profile } = await (
      await this.fetch(`${ZERNIO_API}/profiles`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: 'Postiz' }),
      })
    ).json();

    return profile._id;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    if (body.includes('TOKEN_EXPIRED')) {
      return {
        type: 'disconnect',
        value: 'The channel must be reconnected through Zernio',
      };
    }

    if (body.includes('idempotency_conflict')) {
      return { type: 'retry', value: 'Zernio is still processing this post' };
    }

    try {
      const { error } = JSON.parse(body);
      if (error) {
        return { type: 'bad-body', value: String(error) };
      }
    } catch (err) {}

    return undefined;
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    const redirect = `${process.env.FRONTEND_URL}/integrations/social/${this.identifier}?state=${state}`;

    const { authUrl } = await (
      await this.fetch(
        `${ZERNIO_API}/connect/${this.platform}` +
          `?profileId=${await this.profileId()}` +
          `&redirect_url=${encodeURIComponent(redirect)}`,
        { headers: this.headers() }
      )
    ).json();

    return { url: authUrl, codeVerifier: makeSecureId(10), state };
  }

  // `code` is the Zernio accountId, forwarded by the frontend callback
  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    const { accounts } = await (
      await this.fetch(`${ZERNIO_API}/accounts?platform=${this.platform}`, {
        headers: this.headers(),
      })
    ).json();

    const account = (accounts || []).find((p: any) => p._id === params.code);
    if (!account) {
      return 'Zernio account not found, please connect it again';
    }

    return {
      id: account._id,
      name: account.displayName || account.username || '',
      accessToken: account._id,
      refreshToken: account._id,
      expiresIn: 60 * 60 * 24 * 365 * 10,
      picture: account.profilePicture || '',
      username: account.username || '',
    };
  }

  // Zernio refreshes the platform tokens itself
  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      id: refreshToken,
      name: '',
      accessToken: refreshToken,
      refreshToken,
      expiresIn: 60 * 60 * 24 * 365 * 10,
      picture: '',
      username: '',
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [first, ...comments] = postDetails;

    // Postiz calls post() at the scheduled time, so Zernio publishes right away
    const response = await this.fetch(`${ZERNIO_API}/posts`, {
      method: 'POST',
      headers: { ...this.headers(), 'Idempotency-Key': first.id },
      body: JSON.stringify({
        content: first.message,
        publishNow: true,
        platforms: [
          {
            platform: this.platform,
            accountId: accessToken,
            ...(first.settings && Object.keys(first.settings).length
              ? { platformSpecificData: first.settings }
              : {}),
          },
        ],
        ...(first.media?.length
          ? {
              mediaItems: first.media.map((m) => ({
                type: m.type,
                url: m.path,
              })),
            }
          : {}),
      }),
    });

    const { post } = await response.json();
    const result = post?.platforms?.[0];

    if (result?.status === 'failed') {
      throw new BadBody(
        this.identifier,
        JSON.stringify(result),
        {} as any,
        result.errorMessage || 'Zernio failed to publish the post'
      );
    }

    return [
      {
        id: first.id,
        postId: post._id,
        releaseURL: result?.platformPostUrl || '',
        status: 'completed',
      },
    ];
  }
}

const zernioProvider = (
  platform: string,
  identifier: string,
  name: string,
  maxLength: number
) =>
  new (class extends ZernioProvider {
    platform = platform;
    identifier = identifier;
    name = name;
    maxLength() {
      return maxLength;
    }
  })();

// Platforms connectable through Zernio's hosted OAuth flow
export const zernioProviders = [
  zernioProvider('instagram', 'zernio-instagram', 'Instagram (Zernio)', 2200),
  zernioProvider('facebook', 'zernio-facebook', 'Facebook (Zernio)', 63206),
  zernioProvider('tiktok', 'zernio-tiktok', 'TikTok (Zernio)', 2200),
  zernioProvider('twitter', 'zernio-x', 'X (Zernio)', 280),
  zernioProvider('linkedin', 'zernio-linkedin', 'LinkedIn (Zernio)', 3000),
  zernioProvider('youtube', 'zernio-youtube', 'YouTube (Zernio)', 5000),
  zernioProvider('threads', 'zernio-threads', 'Threads (Zernio)', 500),
  zernioProvider('pinterest', 'zernio-pinterest', 'Pinterest (Zernio)', 500),
  zernioProvider('reddit', 'zernio-reddit', 'Reddit (Zernio)', 40000),
  zernioProvider(
    'googlebusiness',
    'zernio-gmb',
    'Google Business (Zernio)',
    1500
  ),
];
