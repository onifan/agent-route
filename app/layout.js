import Script from "next/script";
import "./globals.css";

export const metadata = {
  title: "AgentRoute 控制台",
  description: "目标驱动自主 Agent 控制台"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Script
          id="agent-route-theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("agent-route.theme")||"dark";var n=t==="light"?"light":"dark";document.documentElement.dataset.theme=n;document.documentElement.classList.toggle("dark",n==="dark")}catch{document.documentElement.dataset.theme="dark";document.documentElement.classList.add("dark")}`
          }}
        />
        <Script
          id="agent-route-browser-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(){
var draftKey="agent-route.goal-draft.v1";
function getGoalInput(){return document.getElementById("goalText")}
function getPriorityInput(){return document.querySelector('select[aria-label="优先级"]')||document.querySelector('select[aria-label="Priority"]')}
function safeDraft(){
  try{var parsed=JSON.parse(localStorage.getItem(draftKey)||"null");return parsed&&typeof parsed==="object"?parsed:null}catch{return null}
}
function saveDraft(){
  var goal=getGoalInput();
  var priority=getPriorityInput();
  if(!goal)return;
  try{localStorage.setItem(draftKey,JSON.stringify({goalText:goal.value||"",priority:priority&&priority.value?priority.value:"normal",updatedAt:new Date().toISOString()}))}catch{}
}
function restoreDraft(){
  var draft=safeDraft();
  if(!draft)return;
  var goal=getGoalInput();
  var priority=getPriorityInput();
  if(goal&&draft.goalText&&!goal.value){
    goal.value=String(draft.goalText||"");
    goal.dispatchEvent(new Event("input",{bubbles:true}));
  }
  if(priority&&draft.priority&&priority.value!==draft.priority){
    priority.value=draft.priority;
    priority.dispatchEvent(new Event("change",{bubbles:true}));
  }
}
function setTheme(t){
  var n=t==="light"?"light":"dark";
  document.documentElement.dataset.theme=n;
  document.documentElement.classList.toggle("dark",n==="dark");
  try{localStorage.setItem("agent-route.theme",n)}catch{}
  document.querySelectorAll("[data-theme-toggle] .material-symbols-outlined,[data-react-theme-toggle] .material-symbols-outlined").forEach(function(i){i.textContent=n==="light"?"dark_mode":"light_mode"})
}
function markIconFontReady(){document.documentElement.classList.add("fonts-loaded")}
try{if(document.fonts&&document.fonts.ready){document.fonts.ready.then(markIconFontReady).catch(markIconFontReady)}else{setTimeout(markIconFontReady,120)}}catch{setTimeout(markIconFontReady,120)}
setTimeout(markIconFontReady,700);
function setTab(tab){
  var tabs=["models","prompts","budget"];
  var index=tabs.indexOf(tab);
  if(index<0){tab="models";index=0}
  document.querySelectorAll("[data-settings-tab]").forEach(function(b){
    var a=b.getAttribute("data-settings-tab")===tab;
    b.classList.toggle("active",a);
    b.setAttribute("aria-selected",a?"true":"false")
  });
  document.querySelectorAll(".settings-tab-panel").forEach(function(p,i){
    var panel=p.getAttribute("data-settings-panel")||tabs[i]||"";
    p.hidden=panel!==tab
  })
}
function openSettings(tab){
  var d=document.querySelector(".model-drawer");
  if(!d)return;
  d.classList.add("open");
  d.setAttribute("aria-hidden","false");
  setTab(tab)
}
function closeSettings(){
  var d=document.querySelector(".model-drawer");
  if(!d)return;
  d.classList.remove("open");
  d.setAttribute("aria-hidden","true")
}
function switchAgentRouteSection(section){
  if(!section)return;
  var labels={
    control:["控制中心","创建目标、查看当前目标状态，并启动安全的目标驱动流程。"],
    chat:["聊天","消息流和内部过程"],
    monitor:["监控中心","观察目标、任务、风险、验证、预算、恢复和事件时间线。"],
    tasks:["任务视图","任务队列、依赖图和人工处理"],
    graph:["执行图","查看依赖关系、可执行任务、阻塞链和产物流向。"],
    queue:["任务队列","处理等待确认、阻塞、失败、重试和已完成任务。"],
    models:["模型管理","查看模型等级、成本状态，并调整路由配置。"],
    providers:["供应商设置","管理供应商、API Key 和自定义模型端点。"],
    memory:["记忆","检索和维护长期经验，帮助系统减少重复错误。"],
    logs:["执行日志","查看本地执行日志、错误和最近事件。"]
  };
  try{history.replaceState(null,"","#"+section)}catch{}
  try{window.dispatchEvent(new CustomEvent("agent-route-section-change",{detail:{section:section}}))}catch{}
  document.documentElement.dataset.agentRouteSection=section;
  document.querySelectorAll("[data-agent-section]").forEach(function(panel){
    panel.hidden=panel.getAttribute("data-agent-section")!==section
  });
  var main=document.querySelector(".main");
  if(main&&main.scrollTo)main.scrollTo({top:0,behavior:"smooth"});
  document.querySelectorAll("[data-scroll-target]").forEach(function(b){
    var active=b.getAttribute("data-scroll-target")===section;
    b.classList.toggle("active",active);
    b.setAttribute("aria-current",active?"page":"false")
  });
  if(labels[section]){
    var title=document.querySelector(".topbar .title h1");
    var subtitle=document.querySelector(".topbar .title p");
    if(title)title.textContent=labels[section][0];
    if(subtitle)subtitle.textContent=labels[section][1]
  }
  var sidebar=document.querySelector(".sidebar");
  if(sidebar)sidebar.classList.remove("open")
}
document.addEventListener("input",function(e){
  if(e.target&&e.target.id==="goalText")saveDraft()
});
document.addEventListener("change",function(e){
  if(e.target&&e.target.matches&&e.target.matches('select[aria-label="优先级"],select[aria-label="Priority"]'))saveDraft()
});
document.addEventListener("click",function(e){
  var theme=e.target.closest("[data-theme-toggle],[data-react-theme-toggle]");
  if(theme){setTheme(document.documentElement.dataset.theme==="light"?"dark":"light");return}
  if(e.target.closest("[data-open-sidebar]")){var openSidebar=document.querySelector(".sidebar");if(openSidebar)openSidebar.classList.add("open");return}
  if(e.target.closest("[data-close-sidebar]")){var closeSidebar=document.querySelector(".sidebar");if(closeSidebar)closeSidebar.classList.remove("open");return}
  var open=e.target.closest("[data-open-settings]");
  if(open){openSettings(open.getAttribute("data-open-settings"));return}
  if(e.target.closest("[data-open-providers]")){switchAgentRouteSection("providers");return}
  if(e.target.closest("[data-close-settings]")){closeSettings();return}
  var tab=e.target.closest("[data-settings-tab]");
  if(tab){setTab(tab.getAttribute("data-settings-tab"));return}
  var scroll=e.target.closest("[data-scroll-target]");
  if(scroll){switchAgentRouteSection(scroll.getAttribute("data-scroll-target"));return}
  if(e.target.closest("[data-focus-goal]")){var goal=document.getElementById("goalText");if(goal)goal.focus()}
});
document.addEventListener("DOMContentLoaded",function(){
  setTheme(document.documentElement.dataset.theme||"dark");
  restoreDraft();
  setTimeout(restoreDraft,50);
  setTimeout(restoreDraft,250)
});
window.addEventListener("pageshow",restoreDraft);
})();`
          }}
        />
        {children}
      </body>
    </html>
  );
}
