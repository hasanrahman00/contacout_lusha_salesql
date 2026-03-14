// ═════════════════════════════════════════════════════════════════
// 🌐 TASK: Navigate to LinkedIn Sales Navigator
// ═════════════════════════════════════════════════════════════════
// Purpose: Open or reuse LinkedIn search page
// ═════════════════════════════════════════════════════════════════

async function navigateToLinkedIn(context, linkedinUrl) {
    console.log('🌐 Opening LinkedIn Sales Navigator...');
    
    // 🔍 Check if LinkedIn is already open in a tab
    const existingPage = context.pages().find(p => 
        p.url().includes('linkedin.com/sales')
    );
    
    let page;
    if (existingPage) {
        console.log('♻️ Using existing LinkedIn tab');
        page = existingPage;
        await page.goto(linkedinUrl, { waitUntil: 'domcontentloaded' });
    } else {
        console.log('📄 Creating new tab for LinkedIn');
        page = await context.newPage();
        await page.goto(linkedinUrl, { waitUntil: 'domcontentloaded' });
    }
    
    console.log('✅ LinkedIn page ready');
    
    return page;
}

module.exports = { navigateToLinkedIn };
