import test from 'node:test';
import assert from 'node:assert/strict';
import { formatIssues,hasSteps } from '../src/reply-style.js';

test('列表至少两行，步骤文字沿用共用规则',()=>{
 for(const text of ['1. 先喝水\n2. 再出门','1、先坐下\n2、再聊聊','一、先说这个\n二、再说那个','- 想到了\n- 又想到了','* 苹果\n* 香蕉','第一步先喝水，第二步再出门','第1步先喝水','首先吃饭，然后散步，最后回家']){
  assert.equal(hasSteps(text),true,text);assert.deepEqual(formatIssues(text),['list-or-steps'],text);
 }
 for(const text of ['3.5 分也太低了吧','3.5 分也太低了吧\n4.5 分也没高多少','1、我觉得可以','- 只有一条','——我也这么想','句中一个 * 星号','(*´▽｀*)','哈哈哈']){
  assert.equal(hasSteps(text),false,text);assert.deepEqual(formatIssues(text),[],text);
 }
});

test('Markdown识别标题、两种加粗与代码块，类别稳定且不重复',()=>{
 for(const text of ['# 标题','###### 标题','**加粗**','__加粗__','```js\nconst a=1;\n```'])assert.deepEqual(formatIssues(text),['markdown'],text);
 for(const text of ['####### 不是六级以内标题','#没有空格','普通 * 星号','我_也_觉得','颜文字 (*^▽^*)'])assert.deepEqual(formatIssues(text),[],text);
 assert.deepEqual(formatIssues('## 一起聊聊\n1. **先坐下**\n2. 再喝水'),['list-or-steps','markdown']);
});
