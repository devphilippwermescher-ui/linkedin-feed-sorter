(function () {
  if ((window as any).__linkedinFeedSorterInjected) {
    return;
  }
  (window as any).__linkedinFeedSorterInjected = true;

  console.log('[LinkedIn Analyzer] Interceptor loaded');

  window.postMessage(
    {
      type: "LINKEDIN_FEED_SESSION_START",
      timestamp: Date.now(),
    },
    "*"
  );

  function isFeedRequest(url: string | null | undefined): boolean {
    if (!url || typeof url !== "string") return false;
    const hasGraphQL = url.includes("voyager/api/graphql");
    const hasMainFeed =
      url.includes("feedDashMainFeed") ||
      url.includes("queryId=voyagerFeedDashMainFeed") ||
      url.includes("MainFeed");
    const hasProfileFeed =
      url.includes("feedDashProfileUpdates") ||
      url.includes("voyagerFeedDashProfileUpdates") ||
      url.includes("ProfileUpdates");
    return hasGraphQL && (hasMainFeed || hasProfileFeed);
  }

  function getRequestType(url: string | null | undefined): 'main' | 'profile' | null {
    if (!url || typeof url !== "string") return null;
    if (url.includes("feedDashProfileUpdates") || 
        url.includes("voyagerFeedDashProfileUpdates") ||
        url.includes("ProfileUpdates")) {
      return 'profile';
    }
    if (url.includes("feedDashMainFeed") || 
        url.includes("voyagerFeedDashMainFeed") ||
        url.includes("MainFeed")) {
      return 'main';
    }
    return null;
  }

  const originalFetch = window.fetch.bind(window);

  const fetchWrapper = async function (
    this: any,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request)?.url;

    if (isFeedRequest(url)) {
      const requestType = getRequestType(url);
      console.log('[LinkedIn Analyzer] Feed request intercepted (fetch):', requestType, url?.substring(0, 100));
      try {
        const response = await originalFetch(input, init);
        const clonedResponse = response.clone();

        clonedResponse
          .json()
          .then((data: any) => {
            console.log('[LinkedIn Analyzer] Feed data received:', {
              hasData: !!data?.data,
              includedCount: data?.included?.length || 0,
              requestType,
            });
            window.postMessage(
              {
                type: "LINKEDIN_FEED_DATA_FROM_PAGE",
                data: data,
                url: url,
                feedType: requestType,
                timestamp: Date.now(),
              },
              "*"
            );
          })
          .catch((e) => {
            console.log('[LinkedIn Analyzer] Error parsing fetch response:', e);
          });

        return response;
      } catch (error) {
        console.log('[LinkedIn Analyzer] Fetch error:', error);
        return originalFetch(input, init);
      }
    }

    return originalFetch(input, init);
  };

  (window as any).fetch = fetchWrapper;

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    const urlStr = typeof url === "string" ? url : url.toString();
    (this as any)._linkedinUrl = urlStr;
    return originalXHROpen.call(
      this,
      method,
      url,
      async !== false,
      username,
      password
    );
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const url = (this as any)._linkedinUrl;

    if (isFeedRequest(url)) {
      const requestType = getRequestType(url);
      console.log('[LinkedIn Analyzer] Feed request intercepted (XHR):', requestType, url?.substring(0, 100));
      this.addEventListener("load", async function () {
        try {
          let data: any;

          if (this.responseType === "blob" && this.response instanceof Blob) {
            const text = await this.response.text();
            data = JSON.parse(text);
          } else if (this.responseType === "" || this.responseType === "text") {
            data = JSON.parse(this.responseText);
          } else if (this.responseType === "json") {
            data = this.response;
          } else {
            console.log('[LinkedIn Analyzer] Unknown response type:', this.responseType);
            return;
          }

          console.log('[LinkedIn Analyzer] XHR data received:', {
            hasData: !!data?.data,
            includedCount: data?.included?.length || 0,
            requestType,
          });

          window.postMessage(
            {
              type: "LINKEDIN_FEED_DATA_FROM_PAGE",
              data: data,
              url: url,
              feedType: requestType,
              timestamp: Date.now(),
            },
            "*"
          );
        } catch (error) {
          console.log('[LinkedIn Analyzer] XHR parse error:', error);
        }
      });
    }

    return originalXHRSend.call(this, body);
  };
})();
