// ツールバーアイコンをクリックしたら、専用タブでビューアを開く
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});
