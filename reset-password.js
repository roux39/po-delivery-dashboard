// 구매팀 비밀번호를 지우고 모든 로그인을 해제한다. 현황판을 끈 상태에서 실행: node reset-password.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, 'data', 'fifo.db'));
db.exec("DELETE FROM settings WHERE k='password'; DELETE FROM sessions;");
console.log('비밀번호를 초기화했어요. 현황판을 다시 켜고 접속하면 새 비밀번호를 정할 수 있어요.');
