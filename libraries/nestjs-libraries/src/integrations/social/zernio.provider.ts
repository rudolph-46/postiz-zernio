import dayjs from 'dayjs';
import {
  AnalyticsData,
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
export class ZernioProvider extends SocialAbstract implements SocialProvider {
  // platform is the Zernio platform value, e.g. "twitter"
  constructor(
    public platform: string,
    public identifier: string,
    public name: string,
    private max: number
  ) {
    super();
  }

  maxLength() {
    return this.max;
  }

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

  // `id` is the Zernio account id (also stored as access token)
  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const fromDate = dayjs().subtract(date, 'day').format('YYYY-MM-DD');
    const toDate = dayjs().format('YYYY-MM-DD');

    const [followers, posts] = await Promise.all([
      this.fetch(
        `${ZERNIO_API}/accounts/follower-stats?accountIds=${id}&fromDate=${fromDate}&toDate=${toDate}`,
        { headers: this.headers() }
      ).then((r) => r.json()),
      this.fetch(
        `${ZERNIO_API}/analytics?accountId=${id}&fromDate=${fromDate}&toDate=${toDate}&limit=100`,
        { headers: this.headers() }
      ).then((r) => r.json()),
    ]);

    const perDay = (metric: string) => {
      const days: Record<string, number> = {};
      for (const post of posts?.posts || []) {
        const day = dayjs(post.publishedAt || post.scheduledFor).format(
          'YYYY-MM-DD'
        );
        days[day] = (days[day] || 0) + Number(post.analytics?.[metric] || 0);
      }
      return Object.entries(days).map(([day, total]) => ({
        total: String(total),
        date: day,
      }));
    };

    return [
      {
        label: 'Followers',
        percentageChange: 0,
        data: (followers?.stats?.[id] || []).map((point: any) => ({
          total: String(point.followers ?? point.count ?? 0),
          date: dayjs(point.date).format('YYYY-MM-DD'),
        })),
      },
      ...['impressions', 'reach', 'likes', 'comments', 'shares'].map(
        (metric) => ({
          label: metric.charAt(0).toUpperCase() + metric.slice(1),
          percentageChange: 0,
          data: perDay(metric),
        })
      ),
    ];
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

// Platforms connectable through Zernio's hosted OAuth flow
export const zernioProviders = [
  new ZernioProvider(
    'instagram',
    'zernio-instagram',
    'Instagram (Zernio)',
    2200
  ),
  new ZernioProvider('facebook', 'zernio-facebook', 'Facebook (Zernio)', 63206),
  new ZernioProvider('tiktok', 'zernio-tiktok', 'TikTok (Zernio)', 2200),
  new ZernioProvider('twitter', 'zernio-x', 'X (Zernio)', 280),
  new ZernioProvider('linkedin', 'zernio-linkedin', 'LinkedIn (Zernio)', 3000),
  new ZernioProvider('youtube', 'zernio-youtube', 'YouTube (Zernio)', 5000),
  new ZernioProvider('threads', 'zernio-threads', 'Threads (Zernio)', 500),
  new ZernioProvider(
    'pinterest',
    'zernio-pinterest',
    'Pinterest (Zernio)',
    500
  ),
  new ZernioProvider('reddit', 'zernio-reddit', 'Reddit (Zernio)', 40000),
  new ZernioProvider(
    'googlebusiness',
    'zernio-gmb',
    'Google Business (Zernio)',
    1500
  ),
];
