export const styles = `
.leaderboard .page-heading{margin-bottom:16px}
.leaderboard-tabs{display:flex;align-items:center;gap:20px;border-bottom:1px solid var(--border);margin-bottom:20px}
.leaderboard-tabs>button{position:relative;display:inline-flex;align-items:center;gap:7px;padding:10px 0 12px;border:0;border-radius:0;background:transparent;color:var(--muted);box-shadow:none;font-weight:500}
.leaderboard-tabs>button:hover,.leaderboard-tabs>button.active{color:var(--accent)}
.leaderboard-tabs>button.active:after{position:absolute;inset:auto 0 -1px;height:2px;background:var(--accent);content:""}
.leaderboard-scope{margin-left:auto;color:var(--muted);font-size:11px;cursor:help}
.leaderboard-summary{display:flex;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:20px;background:var(--surface)}
.leaderboard-summary>div{flex:1;min-width:0;padding:14px 18px;border-right:1px solid var(--border)}
.leaderboard-summary>div:last-child{border:0}
.leaderboard-summary span{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}
.leaderboard-summary strong{font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
.leaderboard-my-summary strong{color:var(--accent)}
.leaderboard table{min-width:620px;font-variant-numeric:tabular-nums}
.leaderboard th:first-child,.leaderboard td:first-child{width:80px;text-align:center}
.leaderboard th:nth-child(n+3),.leaderboard td:nth-child(n+3){text-align:right}
.leaderboard td:nth-child(2){width:42%}
.leaderboard td strong{font-weight:550}
.leaderboard td small,.leaderboard th small{display:block;font-size:11px;font-weight:400;color:var(--muted);margin-top:3px}
.leaderboard-rank{display:inline-flex;align-items:center;justify-content:center;gap:5px;color:var(--muted);min-width:36px}
.leaderboard-rank.rank-1{color:#ad7a1f}.leaderboard-rank.rank-2{color:#6d8195}.leaderboard-rank.rank-3{color:#ab7051}
:root[data-theme="dark"] .leaderboard-rank.rank-1{color:#e2bd72}
:root[data-theme="dark"] .leaderboard-rank.rank-2{color:#bcc8d6}
:root[data-theme="dark"] .leaderboard-rank.rank-3{color:#dba48b}
.leaderboard-identity{display:flex;align-items:center;gap:10px;min-width:0}
.leaderboard-identity>div{min-width:0}
.leaderboard-identity strong,.leaderboard-identity small{display:block;max-width:310px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.leaderboard-avatar{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;border-radius:8px;background:var(--subtle);color:var(--muted);font-size:12px;font-weight:600}
.leaderboard-me{background:var(--accent-soft)}
.leaderboard-me .leaderboard-avatar{background:var(--surface);color:var(--accent)}
.leaderboard-sorted>strong{color:var(--accent)}
.leaderboard-share{display:flex;align-items:center;justify-content:flex-end;gap:10px;font-size:12px;color:var(--muted)}
.leaderboard-meter{width:70px;height:4px;flex:none;background:var(--subtle);border-radius:4px;overflow:hidden}
.leaderboard-meter>i{display:block;height:100%;background:var(--accent);border-radius:inherit}
.leaderboard tfoot{border-top:2px solid var(--border)}
.leaderboard-footnote{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--muted)}
.leaderboard-footnote>span[title]{cursor:help}
@media(max-width:640px){.leaderboard-summary{flex-wrap:wrap}.leaderboard-summary>div{flex-basis:50%;padding:13px 14px}.leaderboard-summary>div:nth-child(2){border-right:0}.leaderboard-summary>div:nth-child(n+3){border-top:1px solid var(--border)}.leaderboard-summary>div:last-child:nth-child(3){flex-basis:100%}.leaderboard-summary strong{font-size:22px}.leaderboard .page-heading>.actions{gap:6px}.leaderboard .page-heading .select-control{min-width:0}.leaderboard-identity strong,.leaderboard-identity small{max-width:210px}.leaderboard-footnote{gap:8px 12px}}
`;
