/**
 * options.js — Options page logic.
 */

const accountStatus = document.getElementById("account-status");

chrome.runtime.sendMessage({ type: "CI_GET_STATUS" }, (resp) => {
  if (resp?.authenticated) {
    accountStatus.className = "status-card ok";
    accountStatus.innerHTML =
      '<div class="info">&#10003; Connected to CollegeInsight</div>';
  } else {
    accountStatus.className = "status-card warn";
    accountStatus.innerHTML =
      '<div class="info">&#9888; Not connected — open <a href="https://www.collegeinsight.ai" target="_blank">CollegeInsight.ai</a> and sign in to sync.</div>';
  }
});
