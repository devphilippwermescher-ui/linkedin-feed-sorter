import React from "react";
import { LinkedInPost } from "types/linkedin";
import { 
  HiOutlineHandThumbUp, 
  HiOutlineChatBubbleLeftRight, 
  HiOutlineArrowPath, 
  HiOutlineChartBar 
} from "react-icons/hi2";

interface PostItemProps {
  post: LinkedInPost;
}

const PostItem: React.FC<PostItemProps> = ({ post }) => {
  const engagementScore =
    post.numLikes + post.numComments * 2 + post.numShares * 3;

  return (
    <div className={`post-item ${post.isSponsored ? "sponsored" : ""}`}>
      <div className="post-header">
        <div className="author-info">
          <strong>{post.authorName || "Unknown"}</strong>
          {post.isSponsored && (
            <span className="sponsored-badge">Sponsored</span>
          )}
        </div>
        <div className="post-urn">
          {post.activityUrn.split(":").pop()?.substring(0, 8)}...
        </div>
      </div>

      {post.text && (
        <div className="post-text">
          {post.text.length > 150
            ? `${post.text.substring(0, 150)}...`
            : post.text}
        </div>
      )}

      {post.hashtags && post.hashtags.length > 0 && (
        <div className="post-hashtags">
          {post.hashtags.map((tag: string, idx: number) => (
            <span key={idx} className="hashtag">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="post-stats">
        <div className="stat-item">
          <HiOutlineHandThumbUp className="stat-icon" />
          <span className="stat-value">{post.numLikes.toLocaleString()}</span>
        </div>
        <div className="stat-item">
          <HiOutlineChatBubbleLeftRight className="stat-icon" />
          <span className="stat-value">
            {post.numComments.toLocaleString()}
          </span>
        </div>
        <div className="stat-item">
          <HiOutlineArrowPath className="stat-icon" />
          <span className="stat-value">{post.numShares.toLocaleString()}</span>
        </div>
        <div className="stat-item engagement">
          <HiOutlineChartBar className="stat-icon" />
          <span className="stat-label">Engagement:</span>
          <span className="stat-value">{engagementScore.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
};

export default PostItem;
