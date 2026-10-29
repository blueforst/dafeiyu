// 使用实际目录或窄屏下拉选择条目，不绕过界面写入内部状态。
export async function pickPersonaItem(page,key){
 const mobile=page.getByLabel('选择人设段落',{exact:true});
 if(await mobile.isVisible())await mobile.selectOption(key);
 else await page.locator('[data-pe-select="'+key+'"]').click();
 await page.locator('.pe-detail').waitFor();
}
export async function pickPersonaSection(page,index){
 await pickPersonaItem(page,'s:'+index);
 await page.locator('#persona-section-'+index).waitFor();
}
export async function readPersonaSection(page,index){
 // 生产只读检查也兼容尚未发布目录改版的旧卡片页；新布局仅挂载选中项。
 if(!await page.locator('#persona-section-'+index).count())await pickPersonaSection(page,index);
 return page.locator('#persona-section-'+index).evaluate(el=>el instanceof HTMLTextAreaElement?el.value:el.textContent);
}
