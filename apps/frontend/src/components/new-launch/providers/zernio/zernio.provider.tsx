'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';

export const zernioProvider = (maximumCharacters: number) =>
  withProvider({
    postComment: PostComment.COMMENT,
    minimumCharacters: [],
    SettingsComponent: null,
    CustomPreviewComponent: undefined,
    dto: undefined,
    maximumCharacters,
  });
