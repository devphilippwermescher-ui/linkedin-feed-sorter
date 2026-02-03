export interface LinkedInPost {
  activityUrn: string;
  authorName: string;
  authorUrn: string;
  text?: string;
  numLikes: number;
  numComments: number;
  numShares: number;
  timestamp?: number;
  isSponsored?: boolean;
  hashtags?: string[];
}

export interface SocialActivityCounts {
  numLikes: number;
  numComments: number;
  numShares: number;
  urn: string;
  reactionTypeCounts?: Array<{
    count: number;
    reactionType: string;
  }>;
}

export interface LinkedInAPIResponse {
  data?: {
    data?: {
      feedDashMainFeedByMainFeed?: {
        '*elements'?: string[];
        paging?: {
          count: number;
          start: number;
          total: number;
        };
      };
    };
  };
  included?: any[];
}

export type SortOption = 'likes' | 'comments' | 'shares' | 'engagement' | 'default';

