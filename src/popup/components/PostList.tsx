import React from 'react';
import { LinkedInPost } from 'types/linkedin';
import PostItem from './PostItem';

interface PostListProps {
  posts: LinkedInPost[];
}

const PostList: React.FC<PostListProps> = ({ posts }) => {
  return (
    <div className="post-list">
      {posts.map((post, index) => (
        <PostItem key={`${post.activityUrn}-${index}`} post={post} />
      ))}
    </div>
  );
};

export default PostList;

