'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';

// Zernio only accepts media on a comment on Facebook, so every other platform
// hides the media picker once the composer is writing a comment.
export const zernioProvider = (
  maximumCharacters: number,
  comments: boolean | 'no-media' = 'no-media'
) =>
  withProvider({
    comments,
    postComment: PostComment.COMMENT,
    minimumCharacters: [],
    SettingsComponent: null,
    CustomPreviewComponent: undefined,
    dto: undefined,
    maximumCharacters,
  });
