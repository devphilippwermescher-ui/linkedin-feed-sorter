import React, { useState, useEffect, useCallback } from "react";
import { LinkedInPost, SortOption } from "types/linkedin";
import PostList from "./components/PostList";
import { 
  HiOutlineHandThumbUp, 
  HiOutlineChatBubbleLeftRight, 
  HiOutlineArrowPath, 
  HiOutlineChartBar,
  HiOutlineArrowRight
} from "react-icons/hi2";
import "./styles.css";

interface StoredPosts {
  posts: LinkedInPost[];
  lastUpdate: number;
}

interface CollectionStatus {
  isCollecting: boolean;
  targetCount: number;
  currentCount: number;
}

const MAX_POSTS = 2000;
const PRESET_COUNTS = [25, 50, 100, 200, 500];

const App: React.FC = () => {
  const [posts, setPosts] = useState<LinkedInPost[]>([]);
  const [postCount, setPostCount] = useState<number>(25);
  const [customInput, setCustomInput] = useState<string>("25");
  const [selectedFilter, setSelectedFilter] = useState<SortOption>("likes");
  const [isOnFeed, setIsOnFeed] = useState<boolean | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus>({
    isCollecting: false,
    targetCount: 0,
    currentCount: 0,
  });
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    checkCurrentTab();
    checkCollectionState();
    loadPosts();
  }, []);

  useEffect(() => {
    if (isOnFeed === false) {
      document.body.classList.add("landing-mode");
    } else {
      document.body.classList.remove("landing-mode");
    }
  }, [isOnFeed]);

  useEffect(() => {
    if (collectionStatus.isCollecting) {
      const interval = setInterval(checkCollectionProgress, 500);
      return () => clearInterval(interval);
    }
  }, [collectionStatus.isCollecting]);

  const checkCurrentTab = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url || "";
      const onFeed = currentUrl.includes("linkedin.com/feed");
      setIsOnFeed(onFeed);
    });
  };

  const checkCollectionState = () => {
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      if (response?.isCollecting) {
        setCollectionStatus({
          isCollecting: true,
          targetCount: response.targetCount,
          currentCount: response.currentCount,
        });
      }
    });
  };

  const checkCollectionProgress = () => {
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      if (response) {
        setPosts([]);
        
        if (!response.isCollecting && collectionStatus.isCollecting) {
          loadPosts();
          setShowResults(true);
        }
        
        setCollectionStatus({
          isCollecting: response.isCollecting,
          targetCount: response.targetCount,
          currentCount: response.currentCount,
        });
      }
    });
  };

  const loadPosts = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: "GET_POSTS" },
      (response: StoredPosts) => {
        if (response) {
          setPosts(response.posts || []);
        }
      }
    );
  }, []);

  const handlePresetClick = (count: number) => {
    setPostCount(count);
    setCustomInput(count.toString());
  };

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCustomInput(value);
    
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0) {
      setPostCount(Math.min(numValue, MAX_POSTS));
    }
  };

  const handleCustomInputBlur = () => {
    const numValue = parseInt(customInput, 10);
    if (isNaN(numValue) || numValue < 1) {
      setPostCount(25);
      setCustomInput("25");
    } else if (numValue > MAX_POSTS) {
      setPostCount(MAX_POSTS);
      setCustomInput(MAX_POSTS.toString());
    } else {
      setPostCount(numValue);
      setCustomInput(numValue.toString());
    }
  };

  const handleStartSorting = () => {
    setPosts([]);
    setShowResults(false);

    const targetCount = postCount;

    setCollectionStatus({
      isCollecting: true,
      targetCount,
      currentCount: 0,
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        
        chrome.runtime.sendMessage({
          type: "START_COLLECTION",
          targetCount,
          tabId,
        }, () => {
          chrome.tabs.reload(tabId);
        });
      }
    });
  };

  const handleStopCollection = () => {
    chrome.runtime.sendMessage({ type: "STOP_COLLECTION" });
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "STOP_AUTO_SCROLL" }).catch(() => {});
      }
    });
    
    setCollectionStatus((prev) => ({ ...prev, isCollecting: false }));
    loadPosts();
    setShowResults(true);
  };

  const handleGoToFeed = () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/feed" });
  };

  const handleViewResults = () => {
    loadPosts();
    setShowResults(true);
  };

  const handleBackToSetup = () => {
    setShowResults(false);
  };

  const sortedPosts = React.useMemo(() => {
    const postsCopy = [...posts];

    let sorted: LinkedInPost[];
    switch (selectedFilter) {
      case "likes":
        sorted = postsCopy.sort((a, b) => b.numLikes - a.numLikes);
        break;
      case "comments":
        sorted = postsCopy.sort((a, b) => b.numComments - a.numComments);
        break;
      case "shares":
        sorted = postsCopy.sort((a, b) => b.numShares - a.numShares);
        break;
      case "engagement":
        sorted = postsCopy.sort((a, b) => {
          const engagementA = a.numLikes + a.numComments * 2 + a.numShares * 3;
          const engagementB = b.numLikes + b.numComments * 2 + b.numShares * 3;
          return engagementB - engagementA;
        });
        break;
      default:
        sorted = postsCopy;
    }

    return sorted.slice(0, postCount);
  }, [posts, selectedFilter, postCount]);

  const filterOptions: { value: SortOption; label: string }[] = [
    { value: "likes", label: "Likes" },
    { value: "comments", label: "Comments" },
    { value: "shares", label: "Shares" },
    { value: "engagement", label: "Engagement" },
  ];

  const renderFilterIcon = (value: SortOption) => {
    switch (value) {
      case 'likes':
        return <HiOutlineHandThumbUp className="filter-icon" />;
      case 'comments':
        return <HiOutlineChatBubbleLeftRight className="filter-icon" />;
      case 'shares':
        return <HiOutlineArrowPath className="filter-icon" />;
      case 'engagement':
        return <HiOutlineChartBar className="filter-icon" />;
      default:
        return null;
    }
  };

  if (isOnFeed === null) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (!isOnFeed) {
    return (
      <div className="app landing">
        <div className="landing-content">
          <div className="landing-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
            </svg>
          </div>
          <h1>LinkedIn Analyzer</h1>
          <p className="landing-description">
            Analyze and sort your LinkedIn feed posts by engagement metrics
          </p>
          <button className="go-to-feed-button" onClick={handleGoToFeed}>
            <HiOutlineArrowRight className="button-icon" />
            Go to LinkedIn Feed
          </button>
          <p className="landing-hint">
            Open this extension while browsing your LinkedIn feed to start
            analyzing posts
          </p>
        </div>
      </div>
    );
  }

  if (showResults) {
    return (
      <div className="app results-view">
        <header className="results-header">
          <button className="back-button" onClick={handleBackToSetup}>
            ← Back
          </button>
          <div className="results-info">
            <span className="results-count">{sortedPosts.length} posts</span>
          </div>
        </header>
        <div className="results-filters">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              className={`results-filter-button ${selectedFilter === option.value ? 'active' : ''}`}
              onClick={() => setSelectedFilter(option.value)}
            >
              {option.value === 'likes' && <HiOutlineHandThumbUp className="filter-icon" />}
              {option.value === 'comments' && <HiOutlineChatBubbleLeftRight className="filter-icon" />}
              {option.value === 'shares' && <HiOutlineArrowPath className="filter-icon" />}
              {option.value === 'engagement' && <HiOutlineChartBar className="filter-icon" />}
              <span className="filter-label">{option.label}</span>
            </button>
          ))}
        </div>
        <PostList posts={sortedPosts} />
      </div>
    );
  }

  return (
    <div className="app setup-view">
      <header className="main-header">
        <div className="header-left">
          <img src="icons/icon48.png" alt="Logo" className="header-logo" />
          <h1 className="header-title">LinkedIn Analyzer</h1>
        </div>
        <span className="free-badge">Free</span>
      </header>

      <div className="setup-content">
        <section className="setup-section">
          <h2 className="section-title">Number of Posts to Analyze</h2>
          
          <div className="count-selector">
            <div className="preset-buttons">
              {PRESET_COUNTS.map((count) => (
                <button
                  key={count}
                  className={`preset-button ${postCount === count ? 'active' : ''}`}
                  onClick={() => handlePresetClick(count)}
                >
                  {count}
                </button>
              ))}
            </div>
            
            <div className="custom-input-wrapper">
              <label className="custom-label">Custom:</label>
              <input
                type="number"
                className="custom-input"
                value={customInput}
                onChange={handleCustomInputChange}
                onBlur={handleCustomInputBlur}
                min={1}
                max={MAX_POSTS}
              />
              <span className="max-hint">Max: {MAX_POSTS}</span>
            </div>
          </div>
        </section>

        <section className="filter-section">
          <h2 className="section-title">Sort By</h2>
          <div className="filter-buttons">
            {filterOptions.map((option) => (
              <button
                key={option.value}
                className={`filter-button ${selectedFilter === option.value ? 'active' : ''}`}
                onClick={() => setSelectedFilter(option.value)}
              >
                {renderFilterIcon(option.value)}
                <span className="filter-label">{option.label}</span>
              </button>
            ))}
          </div>
        </section>

        {collectionStatus.isCollecting ? (
          <div className="collection-progress">
            <div className="progress-info">
              <span className="progress-text">
                Collecting posts... {collectionStatus.currentCount} / {collectionStatus.targetCount}
              </span>
              <div className="progress-bar">
                <div 
                  className="progress-fill"
                  style={{ 
                    width: `${(collectionStatus.currentCount / collectionStatus.targetCount) * 100}%`
                  }}
                />
              </div>
            </div>
            <button className="stop-button" onClick={handleStopCollection}>
              STOP & VIEW RESULTS
            </button>
          </div>
        ) : (
          <>
            <button className="start-button" onClick={handleStartSorting}>
              START SORTING
            </button>
            
            {posts.length > 0 && (
              <button className="view-results-button" onClick={handleViewResults}>
                VIEW PREVIOUS RESULTS ({posts.length} posts)
              </button>
            )}
          </>
        )}
      </div>

      <footer className="app-footer">
        <p>Having trouble? Email me at support@social-analyzer.com</p>
      </footer>
    </div>
  );
};

export default App;
