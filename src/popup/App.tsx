import React, { useState, useEffect, useRef } from "react";
import { SortOption, PageType, UserPlan, PLAN_INFO, FREE_PLAN_LIMITS } from "types/linkedin";
import { 
  HiOutlineHandThumbUp, 
  HiOutlineChatBubbleLeftRight, 
  HiOutlineArrowPath, 
  HiOutlineChartBar,
  HiOutlineArrowRight,
  HiOutlineArrowsUpDown,
  HiOutlineArrowUturnLeft,
  HiOutlineStar,
  HiOutlineChartBarSquare,
  HiOutlineMagnifyingGlassCircle,
  HiOutlineBolt,
  HiOutlineRocketLaunch,
  HiOutlineArrowDownTray,
  HiOutlineDocumentArrowDown
} from "react-icons/hi2";
import * as XLSX from "xlsx";
import "./styles.css";

interface CollectionStatus {
  isCollecting: boolean;
  targetCount: number | 'all';
  currentCount: number;
  collectAll?: boolean;
}

type AppPhase = 'setup' | 'collecting' | 'sorting' | 'done' | 'error';

const MAX_POSTS = 2000;
const MAIN_FEED_PRESETS = [25, 50, 100, 200, 500];
const PROFILE_FEED_PRESETS = [25, 50, 100, 250];

const App: React.FC = () => {
  const [postCount, setPostCount] = useState<number | 'all'>(25);
  const [customInput, setCustomInput] = useState<string>("25");
  const [selectedFilter, setSelectedFilter] = useState<SortOption>("likes");
  const [pageType, setPageType] = useState<PageType | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus>({
    isCollecting: false,
    targetCount: 0,
    currentCount: 0,
  });
  const [phase, setPhase] = useState<AppPhase>('setup');
  const [sortedCount, setSortedCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [userPlan, setUserPlan] = useState<UserPlan>('free');
  const [showPremiumModal, setShowPremiumModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [sortedPosts, setSortedPosts] = useState<any[]>([]);
  const autoSortTriggered = useRef(false);

  useEffect(() => {
    checkCurrentTab();
    checkCollectionState();
    loadUserPlan();
    loadExportData();
  }, []);

  const loadUserPlan = () => {
    chrome.storage.local.get(['userPlan'], (result) => {
      setUserPlan(result.userPlan || 'free');
    });
  };

  const loadExportData = () => {
    chrome.storage.local.get(['exportData'], (result) => {
      if (result.exportData?.posts?.length > 0) {
        setSortedPosts(result.exportData.posts);
        setSortedCount(result.exportData.count || 0);
        if (result.exportData.filter) {
          setSelectedFilter(result.exportData.filter);
        }
      }
    });
  };

  const saveExportData = (posts: any[], count: number, filter: SortOption) => {
    chrome.storage.local.set({
      exportData: { posts, count, filter }
    });
  };

  const clearExportData = () => {
    chrome.storage.local.remove('exportData');
  };

  const togglePlan = () => {
    const newPlan: UserPlan = userPlan === 'free' ? 'premium' : 'free';
    setUserPlan(newPlan);
    chrome.storage.local.set({ userPlan: newPlan });
    if (newPlan === 'free' && typeof postCount === 'number' && postCount > FREE_PLAN_LIMITS.maxPosts) {
      setPostCount(25);
      setCustomInput('25');
    }
  };

  useEffect(() => {
    if (pageType === 'other') {
      document.documentElement.classList.add("landing-mode");
      document.body.classList.add("landing-mode");
    } else {
      document.documentElement.classList.remove("landing-mode");
      document.body.classList.remove("landing-mode");
    }
  }, [pageType]);

  useEffect(() => {
    if (phase === 'collecting') {
      const interval = setInterval(checkCollectionProgress, 500);
      return () => clearInterval(interval);
    }
  }, [phase]);

  const checkCurrentTab = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url || "";
      if (currentUrl.includes("linkedin.com/feed")) {
        setPageType('main-feed');
      } else if (currentUrl.match(/linkedin\.com\/in\/[^/]+\/recent-activity/)) {
        setPageType('profile-feed');
      } else {
        setPageType('other');
      }
    });
  };

  const checkCollectionState = () => {
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      if (response?.isCollecting) {
        setPhase('collecting');
        autoSortTriggered.current = false;
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
      if (!response) return;
        
        setCollectionStatus({
          isCollecting: response.isCollecting,
          targetCount: response.targetCount,
          currentCount: response.currentCount,
        });

      if (!response.isCollecting && phase === 'collecting' && !autoSortTriggered.current) {
        autoSortTriggered.current = true;
        applySort();
      }
    });
  };

  const applySort = () => {
    setPhase('sorting');
    
    chrome.runtime.sendMessage({ type: "GET_POSTS" }, (response) => {
      if (!response?.posts || response.posts.length === 0) {
        setPhase('error');
        setErrorMessage('No posts collected');
        return;
      }

      const posts = [...response.posts];
      let sorted;
      switch (selectedFilter) {
        case "likes":
          sorted = posts.sort((a: any, b: any) => b.numLikes - a.numLikes);
          break;
        case "comments":
          sorted = posts.sort((a: any, b: any) => b.numComments - a.numComments);
          break;
        case "shares":
          sorted = posts.sort((a: any, b: any) => b.numShares - a.numShares);
          break;
        case "engagement":
          sorted = posts.sort((a: any, b: any) => {
            const engA = a.numLikes + a.numComments * 2 + a.numShares * 3;
            const engB = b.numLikes + b.numComments * 2 + b.numShares * 3;
            return engB - engA;
          });
          break;
        default:
          sorted = posts;
      }

      const sortedUrns = sorted.map((p: any) => p.activityUrn);
      const postsData = sorted.map((p: any) => ({
        activityUrn: p.activityUrn,
        authorName: p.authorName,
        text: p.text,
        numLikes: p.numLikes,
        numComments: p.numComments,
        numShares: p.numShares,
      }));

      setSortedPosts(postsData);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(
            tabs[0].id,
            { type: "REORDER_FEED", sortedUrns, postsData },
            (result) => {
              if (result?.success) {
                setPhase('done');
                setSortedCount(result.reorderedCount);
                saveExportData(postsData, result.reorderedCount, selectedFilter);
              } else {
                setPhase('error');
                setErrorMessage(result?.message || 'Failed to reorder feed');
              }
            }
          );
        } else {
          setPhase('error');
          setErrorMessage('LinkedIn tab not found');
        }
      });
    });
  };

  const isCountLocked = (count: number | 'all'): boolean => {
    if (userPlan === 'premium') return false;
    if (count === 'all') return true;
    return count > FREE_PLAN_LIMITS.maxPosts;
  };

  const handlePresetClick = (count: number | 'all') => {
    if (isCountLocked(count)) {
      setShowPremiumModal(true);
      return;
    }
    setPostCount(count);
    if (count === 'all') {
      setCustomInput('');
    } else {
      setCustomInput(count.toString());
    }
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
    if (postCount === 'all') return;
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
    setPhase('collecting');
    autoSortTriggered.current = false;
    setErrorMessage('');

    const targetCount = postCount;

    setCollectionStatus({
      isCollecting: true,
      targetCount,
      currentCount: 0,
      collectAll: targetCount === 'all',
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        chrome.runtime.sendMessage({
          type: "START_COLLECTION",
          targetCount,
          pageType,
          tabId,
          collectionMode: 'precision',
        }, () => {
          chrome.tabs.reload(tabId);
        });
      }
    });
  };

  const handleStopAndSort = () => {
    chrome.runtime.sendMessage({ type: "STOP_COLLECTION" });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "STOP_AUTO_SCROLL" }).catch(() => {});
      }
    });
    setCollectionStatus((prev) => ({ ...prev, isCollecting: false }));
    applySort();
  };

  const handleRestoreFeed = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "RESTORE_FEED" }, () => {
          setPhase('setup');
          setSortedCount(0);
          setSortedPosts([]);
          clearExportData();
        });
      }
    });
  };

  const handleBackToSetup = () => {
    setPhase('setup');
    setErrorMessage('');
  };

  const handleGoToFeed = () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/feed" });
  };

  const renderFilterIcon = (value: SortOption) => {
    switch (value) {
      case 'likes': return <HiOutlineHandThumbUp className="filter-icon" />;
      case 'comments': return <HiOutlineChatBubbleLeftRight className="filter-icon" />;
      case 'shares': return <HiOutlineArrowPath className="filter-icon" />;
      case 'engagement': return <HiOutlineChartBar className="filter-icon" />;
      default: return null;
    }
  };

  const filterOptions: { value: SortOption; label: string }[] = [
    { value: "likes", label: "Likes" },
    { value: "comments", label: "Comments" },
    { value: "shares", label: "Shares" },
    { value: "engagement", label: "Engagement" },
  ];

  // Export helpers
  const getExportData = () => {
    return sortedPosts.map((p, i) => ({
      '#': i + 1,
      'Author': p.authorName || '',
      'Post Text': (p.text || '').substring(0, 500),
      'Likes': p.numLikes || 0,
      'Comments': p.numComments || 0,
      'Shares': p.numShares || 0,
      'Post URL': p.activityUrn ? `https://www.linkedin.com/feed/update/${p.activityUrn}` : '',
    }));
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = () => {
    const data = getExportData();
    const ws = XLSX.utils.json_to_sheet(data);
    const colWidths = [
      { wch: 4 }, { wch: 25 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 50 }
    ];
    ws['!cols'] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'LinkedIn Posts');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'linkedin-posts.xlsx');
    setShowExportMenu(false);
  };

  const handleExportCSV = () => {
    const data = getExportData();
    const headers = Object.keys(data[0] || {});
    const csvRows = [
      headers.join(','),
      ...data.map(row =>
        headers.map(h => {
          const val = String((row as any)[h] ?? '');
          return `"${val.replace(/"/g, '""')}"`;
        }).join(',')
      )
    ];
    const csvString = csvRows.join('\n');
    triggerDownload(new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' }), 'linkedin-posts.csv');
    setShowExportMenu(false);
  };

  const handleExportJSON = () => {
    const data = getExportData();
    const jsonString = JSON.stringify(data, null, 2);
    triggerDownload(new Blob([jsonString], { type: 'application/json' }), 'linkedin-posts.json');
    setShowExportMenu(false);
  };

  // Premium Modal
  const PremiumModal = () => (
    <div className="premium-modal-backdrop" onClick={() => setShowPremiumModal(false)}>
      <div className="premium-modal" onClick={(e) => e.stopPropagation()}>
        <button className="premium-modal-close" onClick={() => setShowPremiumModal(false)}>✕</button>
        <h2 className="premium-modal-title">Upgrade to Premium</h2>
        <p className="premium-modal-subtitle">Unlock the full power of LinkedIn Analyzer</p>
        
        <div className="premium-features">
          <div className="premium-feature">
            <div className="premium-feature-icon-wrap">
              <HiOutlineChartBarSquare className="premium-feature-icon" />
            </div>
            <div className="premium-feature-text">
              <strong>Sort up to 2000 posts</strong>
              <span>Free plan is limited to 25 posts</span>
            </div>
          </div>
          <div className="premium-feature">
            <div className="premium-feature-icon-wrap">
              <HiOutlineMagnifyingGlassCircle className="premium-feature-icon" />
            </div>
            <div className="premium-feature-text">
              <strong>Deep feed analysis</strong>
              <span>Analyze large feeds with precision</span>
            </div>
          </div>
          <div className="premium-feature">
            <div className="premium-feature-icon-wrap">
              <HiOutlineBolt className="premium-feature-icon" />
            </div>
            <div className="premium-feature-text">
              <strong>Quick Panel — unlimited</strong>
              <span>Sort 50, 100+ posts directly from feed</span>
            </div>
          </div>
          <div className="premium-feature">
            <div className="premium-feature-icon-wrap">
              <HiOutlineRocketLaunch className="premium-feature-icon" />
            </div>
            <div className="premium-feature-text">
              <strong>Priority support</strong>
              <span>Get help faster when you need it</span>
            </div>
          </div>
        </div>

        <button className="premium-modal-cta" onClick={() => {
          // TODO: link to payment page
          setShowPremiumModal(false);
        }}>
          <HiOutlineStar className="premium-cta-icon" />
          Get Premium
        </button>
        <p className="premium-modal-price">Starting at $4.99/month</p>
      </div>
      </div>
    );

  if (pageType === null) {
    return <div className="app"><div className="loading">Loading...</div></div>;
  }

  if (pageType === 'other') {
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
            Open this extension while browsing your LinkedIn feed to start analyzing posts
          </p>
        </div>
      </div>
    );
  }

  // Done phase
  if (phase === 'done') {
    return (
      <div className="app setup-view">
        <header className="main-header">
          <div className="header-left">
            <img src="icons/icon48.png" alt="Logo" className="header-logo" />
            <h1 className="header-title">LinkedIn Analyzer</h1>
          </div>
          <div className="header-right">
            <span className={`plan-badge ${userPlan}`} onClick={togglePlan} title="Click to toggle plan (dev)">
              {PLAN_INFO[userPlan].label}
            </span>
          </div>
        </header>
        <div className="setup-content">
          <div className="done-section">
            <div className="done-badge">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12l2 2 4-4"/>
                <circle cx="12" cy="12" r="10"/>
              </svg>
              <span>Feed Sorted!</span>
            </div>
            <p className="done-info">{sortedCount} posts reordered by {selectedFilter}</p>
            <p className="done-hint">Switch to the LinkedIn tab to see the result</p>
            
            <div className="done-actions">
              <button className="restore-button" onClick={handleRestoreFeed}>
                <HiOutlineArrowUturnLeft className="button-icon" />
                Restore
              </button>
              <button className="new-sort-button" onClick={handleBackToSetup}>
                <HiOutlineArrowsUpDown className="button-icon" />
                New Sort
              </button>
            </div>

            {sortedPosts.length > 0 && (
              <div className="export-section">
                <div className="export-header">
                  <HiOutlineArrowDownTray className="export-header-icon" />
                  <span>Export Data</span>
                </div>
                <div className="export-buttons">
                  <button className="export-btn export-btn--excel" onClick={handleExportExcel}>
                    <span className="export-btn-label">Excel</span>
                  </button>
                  <button className="export-btn export-btn--csv" onClick={handleExportCSV}>
                    <span className="export-btn-label">CSV</span>
                  </button>
                  <button className="export-btn export-btn--json" onClick={handleExportJSON}>
                    <span className="export-btn-label">JSON</span>
          </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <footer className="app-footer">
          <p>Having trouble? Email me at <a href="mailto:dev.philipp.wermescher@gmail.com" style={{color: '#034C9D', textDecoration: 'underline', cursor: 'pointer'}}>dev.philipp.wermescher@gmail.com</a></p>
        </footer>
      </div>
    );
  }

  // Error phase
  if (phase === 'error') {
    return (
      <div className="app setup-view">
        <header className="main-header">
          <div className="header-left">
            <img src="icons/icon48.png" alt="Logo" className="header-logo" />
            <h1 className="header-title">LinkedIn Analyzer</h1>
          </div>
          <div className="header-right">
            <span className={`plan-badge ${userPlan}`} onClick={togglePlan} title="Click to toggle plan (dev)">
              {PLAN_INFO[userPlan].label}
            </span>
          </div>
        </header>
        <div className="setup-content">
          <div className="error-section">
            <div className="error-icon">⚠️</div>
            <p className="error-text">{errorMessage}</p>
            <button className="new-sort-button" onClick={handleBackToSetup}>
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleGoToExport = () => {
    setPhase('done');
  };

  // Setup + Collecting + Sorting
  return (
    <div className="app setup-view">
      {showPremiumModal && <PremiumModal />}
      
      <header className="main-header">
        <div className="header-left">
          <img src="icons/icon48.png" alt="Logo" className="header-logo" />
          <h1 className="header-title">LinkedIn Analyzer</h1>
        </div>
        <div className="header-right">
          {sortedPosts.length > 0 && phase === 'setup' && (
            <button className="header-export-btn" onClick={handleGoToExport} title="Export sorted data">
              <HiOutlineDocumentArrowDown className="header-export-icon" />
            </button>
          )}
          <span className={`plan-badge ${userPlan}`} onClick={togglePlan} title="Click to toggle plan (dev)">
            {PLAN_INFO[userPlan].label}
          </span>
        </div>
      </header>

      <div className="setup-content">
        <section className="setup-section">
          <h2 className="section-title">Number of Posts</h2>
          <div className="count-selector">
            <div className="preset-buttons">
              {(pageType === 'profile-feed' ? PROFILE_FEED_PRESETS : MAIN_FEED_PRESETS).map((count) => {
                const locked = isCountLocked(count);
                return (
                <button
                  key={count}
                    className={`preset-button ${postCount === count && !locked ? 'active' : ''} ${locked ? 'locked' : ''}`}
                  onClick={() => handlePresetClick(count)}
                    disabled={phase !== 'setup'}
                >
                  {count}
                    {locked && <span className="lock-icon">🔒</span>}
                </button>
                );
              })}
              {pageType === 'profile-feed' && (
                <button
                  className={`preset-button all-posts ${postCount === 'all' ? 'active' : ''} ${isCountLocked('all') ? 'locked' : ''}`}
                  onClick={() => handlePresetClick('all')}
                  disabled={phase !== 'setup'}
                >
                  All
                  {isCountLocked('all') && <span className="lock-icon">🔒</span>}
                </button>
              )}
            </div>
            {userPlan === 'premium' && (
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
                placeholder={postCount === 'all' ? 'All' : ''}
                  disabled={postCount === 'all' || phase !== 'setup'}
              />
              <span className="max-hint">Max: {MAX_POSTS}</span>
            </div>
            )}
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
                disabled={phase !== 'setup'}
              >
                {renderFilterIcon(option.value)}
                <span className="filter-label">{option.label}</span>
              </button>
            ))}
          </div>
        </section>

        {phase === 'setup' && (
          <button className="start-button" onClick={handleStartSorting}>
            <HiOutlineArrowsUpDown className="button-icon-inline" />
            START SORTING
          </button>
        )}

        {phase === 'collecting' && (
          <div className="collection-progress">
            <div className="progress-info">
              <span className="progress-text">
                {collectionStatus.targetCount === 'all' 
                  ? `Collecting all posts... ${collectionStatus.currentCount} found`
                  : `Collecting posts... ${collectionStatus.currentCount} / ${collectionStatus.targetCount}`
                }
              </span>
              {collectionStatus.targetCount !== 'all' && (
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ 
                      width: `${(collectionStatus.currentCount / (collectionStatus.targetCount as number)) * 100}%`
                    }}
                  />
                </div>
              )}
              {collectionStatus.targetCount === 'all' && (
                <div className="progress-bar infinite">
                  <div className="progress-fill-infinite" />
                </div>
              )}
            </div>
            <button className="stop-button" onClick={handleStopAndSort}>
              STOP & SORT NOW
            </button>
          </div>
        )}

        {phase === 'sorting' && (
          <div className="sorting-progress">
            <div className="sorting-spinner"></div>
            <span className="sorting-text">Sorting and applying to feed...</span>
          </div>
        )}
      </div>

      {userPlan === 'free' && (
        <div className="premium-promo">
          <p className="premium-promo-text">Pro removes limits across sorting, exports & more</p>
          <button className="premium-promo-button" onClick={() => setShowPremiumModal(true)}>
            <HiOutlineStar className="premium-promo-icon" />
            Get Pro
          </button>
          <p className="premium-promo-activate">
            Already bought Pro? <span className="premium-promo-link" onClick={() => { /* TODO: activate flow */ }}>Activate here →</span>
          </p>
        </div>
      )}

      <footer className="app-footer">
        <p>Having trouble? Email me at <a href="mailto:dev.philipp.wermescher@gmail.com" style={{color: '#034C9D', textDecoration: 'underline', cursor: 'pointer'}}>dev.philipp.wermescher@gmail.com</a></p>
      </footer>
    </div>
  );
};

export default App;
