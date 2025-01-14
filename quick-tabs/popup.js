/*
 Copyright (c) 2009 - 2017, Evan Jehu
 All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:
 * Redistributions of source code must retain the above copyright
 notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright
 notice, this list of conditions and the following disclaimer in the
 documentation and/or other materials provided with the distribution.
 * Neither the name of the author nor the
 names of its contributors may be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 DISCLAIMED. IN NO EVENT SHALL EVAN JEHU BE LIABLE FOR ANY
 DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * lazy variable to address the background page
 */
var bg = chrome.extension.getBackgroundPage();

/**
 * connect to the background page on opening
 */
var bgMessagePort = chrome.runtime.connect({name: "qtPopup"});

/**
 * log name constant
 */
var LOG_SRC = "POPUP";

/**
 * empty variable used to cache the browser history once it has been loaded
 */
var historyCache = null;

/**
 * the search implementation to be used when search tabs
 */
var search = null;

/**
 * max number of search results to show when searching bookmarks and history.
 */
var MAX_NON_TAB_RESULTS = 50;
var ONE_WEEK_IN_MS = 604800000;

/**
 * minimum tabs required before bookmarks get searched automatically.
 */
var MIN_TAB_ONLY_RESULTS = bg.autoSearchBookmarks() ? 5 : 0;


/**
 * Simple little timer class to help with optimizations
 */
function Timer() {
  this.start = this.last = (new Date).getTime();
}
Timer.prototype.log = function() {
  var args = Array.prototype.slice.call(arguments);
  var now = (new Date).getTime();
  args.push("total time " + (now - this.start) + " m/s, delta " + (now - this.last) + " m/s");
  log.apply(this, args);
  this.last = now;
};
Timer.prototype.reset = function() {
  this.start = this.last = (new Date).getTime();
};

/**
 * timer to record page initialization events
 */
var pageTimer = new Timer();

/**
 * Log call that prepends the LOG_SRC before delegating to the background page to simplify debugging
 */
function log() {
  if (bg.debug) {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_SRC);
    bg.log.apply(bg, args);
  }
}

function openInNewTab(url) {
  log("opening new tab", url);
  chrome.tabs.create({url: url, index: 1000});
  return closeWindow();
}

function closeWindow() {
  /**
   * unbind document events before closing the popup window, see issue
   * Chrome shortcuts do not work immediately after using quicktabs #95
   */
  log("Unbinding document event handlers.");
	$(document).unbind(); // do both unbind and off, just to be sure.
	$(document).off();
  window.close();
  return false;
}

function closeTabs(tabIds) {
  bg.recordTabsRemoved(tabIds, function() {
    for (var x = 0; x < tabIds.length; x++) {
      var tabId = tabIds[x];
      chrome.tabs.remove(tabId);
      $("#" + tabId).fadeOut("fast").remove();
    }
    $('.closed').remove();
  })
}

function scrollToFocus() {
  var element = $(".withfocus");

  var offset = element.offset().top;
  var elementHeight = element.outerHeight(true) * 2;

  var visible_area_start = $(window).scrollTop();
  var visible_area_end = visible_area_start + window.innerHeight;

  if (offset < visible_area_start + elementHeight) {
    // scrolling up
    $('html,body').animate({scrollTop: offset - elementHeight}, 10);
    return false;
  } else if (offset > visible_area_end - elementHeight) {
    // scrolling down
    $('html,body').animate({scrollTop: offset - window.innerHeight + elementHeight}, 10);
    return false;
  }
  return true;
}

function focus(elem) {
  $(".withfocus").removeClass('withfocus');
  elem.addClass('withfocus');
}

function entryWithFocus() {
  return $(".withfocus");
}

function isFocusSet() {
  return entryWithFocus().length > 0;
}

function focusFirst() {
  return $(".item:first").addClass("withfocus");
}

function focusLast() {
  return $(".item:last").addClass("withfocus");
}

function focusPrev(skip) {
  skip = skip || 1;
  entryWithFocus().removeClass('withfocus').prevAll(".item").eq(skip - 1).addClass('withfocus');
  if (!isFocusSet()) {
    (skip === 1 ? focusLast : focusFirst)();
  }

  scrollToFocus();
}

function focusNext(skip) {
  skip = skip || 1;
  entry = entryWithFocus().removeClass('withfocus').nextAll(".item").eq(skip - 1).addClass('withfocus');
  if (!isFocusSet()) {
    (skip === 1 ? focusFirst : focusLast)();
  }

  scrollToFocus();
}

window.addEventListener('blur', function() {
	// log("lost focus");
	if(!bg.showDevTools()) { // to be able to inspect popup set the already existing flag to keep it open onblur
		closeWindow(); // ensure popup closes when switching to other window (including non-chrome) so hotkeys keep working
	}
});

/**
 * This function takes 2 arrays of tabs and returns a new array that contains all of the valid tabs in the recordedTabsList with
 * and tabs in the queryTabList appended.
 *
 * @param recordedTabsList a list of currently know tabs
 * @param queryTabList a tab query result array
 * @returns {Array} an array of tabs in the same order as recordedTabsList with any invalid entries removed and any tabs found in queryTabList
 *    appended to the end
 */
function compareTabArrays(recordedTabsList, queryTabList) {
  var queriedTabsMap = {};
  var tabsToRender = [];

  for (var i = 0; i < queryTabList.length; i++) {
    if (queryTabList[i] && queryTabList[i].id) {
      queriedTabsMap[queryTabList[i].id] = queryTabList[i];
    }
  }

  for (var x = 0; x < recordedTabsList.length; x++) {
    if (!recordedTabsList[x]) {
      continue;
    }
    var id = recordedTabsList[x].id;
    var tab = queriedTabsMap[id];
    if (tab) {
      tabsToRender.push(tab);
      delete queriedTabsMap[id];
    } else {
      log("  tab found that is not currently reported as open: ", recordedTabsList[x]);
      delete queriedTabsMap[id];
    }
  }

  for (var extraTab in queriedTabsMap) {
    if (queriedTabsMap.hasOwnProperty(extraTab) && bg.includeTab(queriedTabsMap[extraTab])) {
      log('  adding missing tab', queriedTabsMap[extraTab]);
      tabsToRender.push(queriedTabsMap[extraTab]);
    }
  }

  return tabsToRender;
}

/**
 * =============================================================================================================================================================
 * Page initialization, rendering and event hookups
 * =============================================================================================================================================================
 */

$(document).ready(function() {

  // pageTimer.log("Document ready");

  switch(bg.searchType()) {
	case 'fuseT1':
	case 'fuseT2':
      search = new FuseSearch();
      break;
    case 'regex':
      search = new RegExSearch();
      break;
    case 'substring':
      search = new StringContainsSearch();
      break;
    case 'fuzzy':
    default:
      // make sure he have something...
      search = new FuzzySearch();
      break;
  }

  $('<style/>').text(bg.getCustomCss()).appendTo('head');

  $(document).on('keydown.down', function() {
    focusNext();
    return false;
  });

  $(document).on('keydown.up', function() {
    focusPrev();
    return false;
  });

  $(document).on('keydown.tab', function() {
    focusNext();
    return false;
  });

  $(document).on('keydown.shift_tab', function() {
    focusPrev();
    return false;
  });

  (function(skipSize) {
    $(document).on('keydown.pagedown', function() {
      focusNext(skipSize);
    });

    $(document).on('keydown.pageup', function() {
      focusPrev(skipSize);
    });
  }(bg.pageupPagedownSkipSize()));

  $(document).on('keydown.' + bg.getNewTabKey().pattern(), function() {
    var inputText = $("#searchbox");
    var url = bg.getSearchString().replace(/%s/g, encodeURI(inputText.val()));
    chrome.tabs.create({url: url});
    closeWindow();
    return false;
  });

  $(document).on('keydown.return', function() {
    if (!isFocusSet()) {
      focusFirst();
    }

    if (isFocusSet()) {
      entryWithFocus().trigger("click");
    } else {
      var inputText = $("#searchbox");
      var url = searchStringAsUrl(inputText.val());

      log("no tab selected, " + url);
      if (/^(http|https|ftp):\/\/[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,3}(:[a-zA-Z0-9]*)?\/?([a-zA-Z0-9\-\._\?,'/\\\+&amp;%$#=~])*$/.exec(url)) {
        chrome.tabs.create({url: url});
      } else {
        //url = "http://www.google.com/search?q=" + encodeURI($("input[type=text]").val());
        url = bg.getSearchString().replace(/%s/g, encodeURI(inputText.val()));
        chrome.tabs.create({url: url});
        closeWindow();
      }
    }

    return false;
  });

  $(document).on('keydown.' + bg.getCloseTabKey().pattern(), function() {
    bg.swallowSpruriousOnAfter = true;
    if (!isFocusSet()) {
      focusFirst();
    }
    var attr = entryWithFocus().attr('id');
    if (attr) {
      var tabId = parseInt(attr);
      if (entryWithFocus().nextAll(".open").length === 0) {
        focusPrev();
      } else {
        focusNext();
      }
      closeTabs([tabId]);
    }
    return false;
  });

  $(document).on('keydown.' + bg.getCloseAllTabsKey().pattern(), function() {
    var tabids = [];
    $('.open').each(function() {
      tabids.push(parseInt($(this).attr('id')));
    });
    closeTabs(tabids);
    return false;
  });

  $(document).on('keydown.esc', function() {
    return closeWindow();
  });

  $('#searchbox').on({
    'keyup': function() {
      var str = $("#searchbox").val();
      var result = search.executeSearch(str);
      renderTabs(result);

      // store the current search string
      bg.setLastSearchedStr(str)
    }
  });

  /**
   * Try to fetch the last search string.
   * If present, use it to render only matched tabs list
   * else, render all current tabs list
   */
  var lastSearch = bg.lastSearchedStr();
  if (bg.restoreLastSearchedStr() && typeof lastSearch !== "undefined" && lastSearch.length > 0) {
    $("#searchbox").val(lastSearch).select();
    var result = search.executeSearch(lastSearch);
    renderTabsExceptCurrent(result, 100);
  } else {
    drawCurrentTabs();
  }
  // pageTimer.log("Document ready completed");

});

function drawCurrentTabs() {
  /**
   * This seems kinda nasty but it ensures that we are rendering the latest title information for the tabs
   * since this can be updated after pages have loaded
   */
  chrome.tabs.query({}, function(queryResultTabs) {

    // assign the cleaned tabs list back to background.js
    bg.tabs = compareTabArrays(bg.tabs, queryResultTabs);

    /**
     * render only the tabs and closed tabs on initial load (hence the empty array [] for bookmarks), the
     * delay is important to work around issues with Chromes extension rendering on the Mac, refs #91, #168
     */
    renderTabsExceptCurrent({
      allTabs: bg.tabs,
      closedTabs: bg.closedTabs
    }, 100);
  });
}

/**
 * renders all the params tabs except the current one
 * @param params an object that contains the various tab lists to be rendered
 * @param delay (optional) - how long before we render the tab list to the popup html
 */
function renderTabsExceptCurrent(params, delay) {
  chrome.tabs.query({currentWindow:true, active:true}, function(tab) {
    renderTabs(params, delay, tab[0]);
  });
}

/**
 * sort out the tabs and execute the popup template rendering.
 *
 * @param params an object that contains the various tab lists to be rendered
 * @param delay (optional) - how long before we render the tab list to the popup html
 * @param currentTab (optional) - what is the current tab, if defined it will be excluded from the render list
 */
function renderTabs(params, delay, currentTab) {
  if (params === null) {
    return;
  }

  pageTimer.log("start rendering tab template");

  var allTabs = (params.allTabs || []).reduce(function(result, obj) {
    if(currentTab && obj.id === currentTab.id) log(obj.id, currentTab.id, obj.id !== currentTab.id, obj, currentTab);
    if (!currentTab || obj.id !== currentTab.id) {
      obj.templateTabImage = tabImage(obj);
      obj.templateTitle = encodeHTMLSource(obj.title);
      obj.templateTooltip = stripTitle(obj.title);
      obj.templateUrl = encodeHTMLSource(obj.displayUrl || obj.url);
      result.push(obj);
    }
    return result;
  }, []);

  var closedTabs = (params.closedTabs || []).map(function(obj) {
    obj.templateTabImage = tabImage(obj);
    obj.templateTitle = encodeHTMLSource(obj.title);
    obj.templateTooltip = stripTitle(obj.title);
    obj.templateUrl = encodeHTMLSource(obj.displayUrl || obj.url);
    obj.templateUrlPath = encodeHTMLSource(obj.url);
    return obj;
  });

  var bookmarks = (params.bookmarks || []).map(function(obj) {
    obj.templateTitle = encodeHTMLSource(obj.title);
    obj.templateTooltip = stripTitle(obj.title);
    obj.templateUrlPath = encodeHTMLSource(obj.url);
    obj.templateUrl = encodeHTMLSource(obj.displayUrl);
    return obj;
  });

  var history = (params.history || []).map(function(obj) {
    obj.templateTitle = encodeHTMLSource(obj.title);
    obj.templateTooltip = stripTitle(obj.title);
    obj.templateUrlPath = encodeHTMLSource(obj.url);
    obj.templateUrl = encodeHTMLSource(obj.displayUrl);
    return obj;
  });

  var context = {
    'type': params.type || "all",
    'tabs': allTabs,
    'closedTabs': closedTabs,
    'bookmarks': bookmarks,
    'history': history,
    'closeTitle': "close tab (" + bg.getCloseTabKey().pattern() + ")",
    'tabImageStyle': bg.showFavicons() ? "tabimage" : "tabimage hideicon",
    'urlStyle': bg.showUrls() ? "" : "nourl",
    'urls': bg.showUrls(),
    'tips': bg.showTooltips(),
    'noResults': allTabs.length === 0 && closedTabs.length === 0 && bookmarks.length === 0 && history.length === 0,
    'hasClosedTabs': closedTabs.length > 0,
    'hasBookmarks': bookmarks.length > 0,
    'hasHistory': history.length > 0
  };

  /**
   * render the templates, the timeout is required to work around issues with Chromes extension rendering on the Mac, refs #91, #168
   */
  setTimeout(function() {
    document.getElementById("content-list").innerHTML = Mustache.to_html(
        document.getElementById('template').text, context
    );

    focusFirst();

    $('.open').on('click', function() {
			closeWindow();
      bg.switchTabsWithoutDelay(parseInt(this.id));
    });

    $('.closed').on('click', function() {
      // create a new tab for the window
      openInNewTab(this.getAttribute('data-path'));
    });

    $('.bookmark').on('click', function() {
      // create a new tab for the window
      openInNewTab(this.getAttribute('data-path'));
    });

    $('.history').on('click', function() {
      // create a new tab for the window
      openInNewTab(this.getAttribute('data-path'));
    });

    $('.close').on('click', function() {
      closeTabs([parseInt(this.id.substring(1))])
    });

    pageTimer.log("tab template rendered");
  }, delay || 1);
}

/**
 * listen to the background page for key presses and trigger the appropriate responses
 */
bgMessagePort.onMessage.addListener(function(msg) {
  //log("popup message!", msg);
  if (msg.move === "next") {
		focusPrev();
  } else if (msg.move === "prev") {
    focusNext();
  }
});

/**
 * =============================================================================================================================================================
 * Search related functionality
 * =============================================================================================================================================================
 */

function searchStringAsUrl(url) {

  if (!/^(https?|chrome):\/\/.*/.exec(url)) {
    url = "http://" + url;
  }

  return url;
}

/**
 * =============================================================================================================================================================
 * support functions etc
 * =============================================================================================================================================================
 */

function startsWith(str, start) {
  return str.lastIndexOf(start, 0) === 0;
}

function endsWith(str, end) {
  return str.indexOf(end, str.length - end.length) !== -1;
}


/**
 *
 * Modified to 'encode' instances of {} to <b></b> to allow string match highlighting while still escaping HTML.
 *
 */
function encodeHTMLSource(str) {
  var encodeHTMLRules = {"&": "&#38;", "<": "&#60;", ">": "&#62;", '"': '&#34;', "'": '&#39;', "/": '&#47;', "\v": '<b>', "\b": '</b>'},
      matchHTML = /&(?!#?\w+;)|<|>|"|'|\/|[\v]|[\b]/g;
  return str ? str.replace(matchHTML, function(m) {
    return encodeHTMLRules[m] || m;
  }) : str;
}

/**
 *
 *  Strips HTML tags and pre/post marks from given text. Used to remove these from tooltip text.
 *
 */
function stripTitle(str) {
    str = $('<div/>').html(str).text();
    str = str.replace(/(?:[\v]|[\b])/g, '');
    return str;
}

function tabImage(tab) {
  if (tab.audible) {
    return "/assets/noisy.png"
  } else if (tab.favIconUrl && (startsWith(tab.favIconUrl, "data:") || /^https?:\/\/.*/.exec(tab.favIconUrl))) {
    // if the favicon is a valid URL or embedded data return that
    return tab.favIconUrl;
  } else if (/^chrome:\/\/extensions\/.*/.exec(tab.url)) {
    return "/assets/chrome-extensions-icon.png";
  } else {
    return "/assets/blank.png"
  }
}


/**
 * =============================================================================================================================================================
 * Abstract Search
 * =============================================================================================================================================================
 */

function AbstractSearch() {
}

/**
 * If the search string hasn't changed, the keypress wasn't a character
 * but some form of navigation, so we can stop.
 *
 * @returns {boolean}
 */
AbstractSearch.prototype.shouldSearch = function(query) {
  // make sure the this.searchStr variable has been initialized
  if(!this.searchStr) this.searchStr = "";
  var newQuery = this.searchStr !== query;
  this.searchStr = query;
  return newQuery;
};

/**
 * Retrieve the search string from the search box and search the different tab groups following these rules:
 *
 * - if the search string starts or ends with 3 spaces ('   ') search the entire browser history
 * - if the search string starts or ends with 2 spaces ('  ') only search bookmarks
 * - if the search string starts or ends with 1 space (' ') search tabs and bookmarks
 * - otherwise search tabs unless there are less than 5 results in which case include bookmarks
 *
 */
AbstractSearch.prototype.executeSearch = function(query) {

  if (!this.shouldSearch(query)) {
    return null;
  }

  pageTimer.reset();

  // Filter!
  var filteredTabs = [];
  var filteredClosed = [];
  var filteredBookmarks = [];

  if (query.trim().length === 0) {
    // no need to search if the string is empty
    filteredTabs = bg.tabs;
    filteredClosed = bg.closedTabs;
  } else if (query === "<))") {
    filteredTabs = this.audibleSearch(query, bg.tabs);
  } else if (startsWith(query, "   ") || endsWith(query, "   ")) {
    // i hate to break out of a function part way though but...
    this.searchHistory(query, 0);
    return null;
  } else if (startsWith(query, "  ") || endsWith(query, "  ")) {
    filteredBookmarks = this.searchTabArray(query, bg.bookmarks);
  } else {
    filteredTabs = this.searchTabArray(query, bg.tabs);
    filteredClosed = this.searchTabArray(query, bg.closedTabs);
    var resultCount = filteredTabs.length + filteredClosed.length;
    if (startsWith(query, " ") || endsWith(query, " ") || resultCount < MIN_TAB_ONLY_RESULTS) {
      filteredBookmarks = this.searchTabArray(query, bg.bookmarks);
    }
  }

  pageTimer.log("search completed for '" + query + "'");

  // only show the top MAX_NON_TAB_RESULTS bookmark hits.
  return {
    allTabs: filteredTabs,
    closedTabs: filteredClosed,
    bookmarks: filteredBookmarks.slice(0, MAX_NON_TAB_RESULTS)
  };
};

AbstractSearch.prototype.audibleSearch = function(query, tabs) {
  return $.grep(tabs, function(t) {
    return (t.audible && query === "<))");
  });
};

/**
 * Load all of the browser history and search it for the best matches
 *
 * @param searchStr
 * @param since
 */
AbstractSearch.prototype.searchHistory = function(searchStr, since) {
  var doSearch = function(h) {
    renderTabs({
      history: this.searchTabArray(searchStr, h).slice(0, MAX_NON_TAB_RESULTS)
    });
  }.bind(this);

  /**
   * compile the history filter regexp
   */
  var filterString = bg.getHistoryFilter().trim();
  var filterRegEx = filterString.length > 0 ? new RegExp(filterString) : null;

  /**
   * test each url against a regular expression to see if it should be included in the history search
   * https?:\/\/www\.(google|bing)\.(ca|com|co\.uk)\/(search|images)
   */
  var includeUrl = function(url) {
    return !filterRegEx || !filterRegEx.exec(url);
  };

  log("[test] about to look at history");

  if (historyCache !== null) {
    // use the cached values
    // console.log("History cache found! with length: ${historyCache.length()}");
    log("[test] loaded history from cache!", historyCache.length);
    doSearch(historyCache);
  } else {
    // load browser history
    var timeFromAWeekAgo = new Date(time.getTime() - ONE_WEEK_IN_MS);
    chrome.history.search({ text: "", maxResults: 1000, startTime: timeFromAWeekAgo}, function(result) {

      var includeView = function(v) {
        return v.url && v.title && includeUrl(v.url)
      };

      historyCache = result.filter(includeView);

      log("loaded history for search", historyCache.length);

      doSearch(historyCache);
    })
  }
};

/**
 * inserts '\v' and 'b' markers at start and end of search matches
 */
AbstractSearch.prototype.highlightString = function(string, start, end) {
  return string.substring(0, start) + '\v' + string.substring(start, end + 1) + '\b' + string.substring(end + 1);
};

/**
 * =============================================================================================================================================================
 * Fuzzy Search ( https://github.com/myork/fuzzy )
 * =============================================================================================================================================================
 */

function FuzzySearch() {}

FuzzySearch.prototype = Object.create(AbstractSearch.prototype);

FuzzySearch.prototype.searchTabArray = function(query, tabs) {
  var searchUrls = bg.showUrls() || bg.searchUrls();
  var options = {
    pre: '\v',
    post: '\b',
    extract: function(element) {
      if (searchUrls) {
        return element.title + "~~" + element.url;
      } else {
        return element.title;
      }
    }
  };

  return fuzzy.filter(query.trim(), tabs, options).map(function(entry) {
    var parts = entry.string.split(/~~/);
    // return a copy of the important fields for template rendering
    return {
      title: parts[0],
      displayUrl: parts[1],
      url: entry.original.url,
      id: entry.original.id,
      favIconUrl: entry.original.favIconUrl
    }
  });
};

/**
 * =============================================================================================================================================================
 * Fuse Search ( http://fusejs.io/ )
 * =============================================================================================================================================================
 */

function FuseSearch() {}

FuseSearch.prototype = Object.create(AbstractSearch.prototype);

// highlights Fuse results with the matches
FuseSearch.prototype.highlightResult = function(result) {
  var item = result.item;
  var highlighted = {};
  result.matches.forEach(function(match) {
    var formatted = item[match.key];

    // highlight each of the matches
    match.indices.forEach(function(endpoints, i) {
      // each previous match has added two characters
      var offset = i * 2;
      formatted = this.highlightString(formatted, endpoints[0] + offset, endpoints[1] + offset);
    }.bind(this));

    highlighted[match.key] = formatted;
  }.bind(this));
  return highlighted;
};

FuseSearch.prototype.searchTabArray = function(query, tabs) {
   var options = {
     location: 0,
     distance: 1000, // such a high value since searchterm can appear anywhere within URL/Title
     // thus distance from location shouldn't matter much, hence increasing distance.
     shouldSort: true,
     includeMatches: true,
     maxPatternLength: 32,
     minMatchCharLength: 1,
     keys: [{
       name: 'title',
       weight: 1.0
     }]
   };

  if (bg.showUrls() || bg.searchUrls()) {
    options.keys.push({
      name: 'url',
      weight: 0.9
    });
  }

  switch (bg.searchType()) {
    case 'fuseT1':
    default:
      options.threshold = 0.6; //needs higher values since pure fuzzy search results have higher scores
      //keep options as set above
      break;
    case 'fuseT2':
      options.tokenize = true;
      options.matchAllTokens = true;
      options.threshold = 0.4; //can afford lower one since result scores are overall lower and near zero if words match
      break;
  }

  var fuse = new Fuse(tabs, options);

  return fuse.search(query.trim()).map(function(result) {
    var highlighted = this.highlightResult(result);
    return {
      title: highlighted.title || result.item.title,
      displayUrl: highlighted.url || result.item.url,
      url: result.item.url,
      id: result.item.id,
      favIconUrl: result.item.favIconUrl
    }
  }.bind(this));
};

/**
 * =============================================================================================================================================================
 * RegEx Search
 * =============================================================================================================================================================
 */

function RegExSearch() {}

RegExSearch.prototype = Object.create(AbstractSearch.prototype);

/**
 * returns the result with the match highlighted
 */
RegExSearch.prototype.highlightSearch = function(result) {
  if (result) {
    return this.highlightString(result.input, result.index, result.index + result[0].length - 1);
  }
};

RegExSearch.prototype.searchTabArray = function(query, tabs) {
  var that = this;
  var search = new RegExp(query.trim(), 'i');
  return tabs.map(function(tab) {
    var highlightedTitle = that.highlightSearch(search.exec(tab.title));
    var highlightedUrl = (bg.showUrls() || bg.searchUrls()) && that.highlightSearch(search.exec(tab.url));
    if (highlightedTitle || highlightedUrl) {
      return {
        title: highlightedTitle || tab.title,
        displayUrl: highlightedUrl || tab.url,
        url: tab.url,
        id: tab.id,
        favIconUrl: tab.favIconUrl
      }
    }
  }).filter(function(result) {
    return result;
  })
};

/**
 * =============================================================================================================================================================
 * StringContains Search
 * =============================================================================================================================================================
 */

function StringContainsSearch() {}

StringContainsSearch.prototype = Object.create(AbstractSearch.prototype);

/**
 * returns the result with the match highlighted
 */
StringContainsSearch.prototype.highlightSearch = function(str, query) {
  if (str) {
    var i = str.toLowerCase().indexOf(query);
    if (i >= 0) {
      return this.highlightString(str, i, i + query.length - 1);
    }
  }
};

StringContainsSearch.prototype.searchTabArray = function(query, tabs) {
  var q = query.trim().toLowerCase();
  return tabs.map(function(tab) {
    var highlightedTitle = this.highlightSearch(tab.title, q);
    var highlightedUrl = (bg.showUrls() || bg.searchUrls()) && this.highlightSearch(tab.url, q);
    if (highlightedTitle || highlightedUrl) {
      return {
        title: highlightedTitle || tab.title,
        displayUrl: highlightedUrl || tab.url,
        url: tab.url,
        id: tab.id,
        favIconUrl: tab.favIconUrl
      }
    }
  }.bind(this)).filter(function(result) {
    return result;
  })
};
