// =================================================================
// |   TELEGRAM SUPABASE BOT - V56 - FINAL VERSION                 |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const axios = require('axios');

// --- 2. تهيئة Pooler الاتصال بـ Supabase ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                         Helper Functions (دوال مساعدة)                      |
// =================================================================

// دالة لجلب اتصال من الـ Pooler
async function getClient() {
    try {
        return await pool.connect();
    } catch (error) {
        console.error('Failed to get a client from the pool:', error);
        throw error;
    }
}
// دالة جديدة مخصصة لعملية إلغاء التثبيت
// دالة جديدة لبدء مهمة إلغاء التثبيت في الخلفية
async function startUnpinAllJob(ctx, client) {
    try {
        const userId = String(ctx.from.id);
        const insertQuery = `
            INSERT INTO public.background_jobs (job_type, triggered_by_user_id)
            VALUES ('unpin_all', $1)
            RETURNING id;
        `;
        const result = await client.query(insertQuery, [userId]);
        const jobId = result.rows[0].id;

        // إرسال طلب لـ Google Script لبدء المهمة
        await axios.post(process.env.GOOGLE_SCRIPT_URL, { jobId });
        
        await ctx.answerCbQuery('✅ تم بدء عملية إلغاء التثبيت في الخلفية. سيصلك تقرير برسالة جديدة عند الانتهاء.', { show_alert: true });

    } catch(error) {
        console.error("Error starting unpin_all job:", error);
        await ctx.reply('❌ حدث خطأ فادح أثناء محاولة بدء مهمة إلغاء التثبيت.');
    }
}
// دالة لتحويل تنسيقات Markdown الأساسية إلى HTML
function convertMarkdownToHtml(text) {
    if (!text) return '';

    // يجب أن تكون حريصًا على الترتيب لتجنب التداخل
    let html = text;

    // الرابط: [text](url) -> <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    
    // نص عريض: *text* -> <b>text</b>
    html = html.replace(/(?<!\*)\*([^\*]+)\*(?!\*)/g, '<b>$1</b>');

    // نص مائل: _text_ -> <i>text</i>
    html = html.replace(/(?<!\_)\_([^_]+)\_(?!\_)/g, '<i>$1</i>');

    // نص برمجي: `text` -> <code>text</code>
    html = html.replace(/\`([^`]+)\`/g, '<code>$1</code>');

    return html;
}
// دالة مساعدة للحصول على ID المصدر سواء كان مستخدم، بوت، قناة، أو جروب
function getSourceId(ctx) {
    if (ctx.message.forward_from) { // Forwarded from a user or bot
        return String(ctx.message.forward_from.id);
    }
    if (ctx.message.forward_from_chat) { // Forwarded from a channel or group
        return String(ctx.message.forward_from_chat.id);
    }
    return null;
}
// دالة مساعدة لحذف زر وكل محتوياته وأزراره الفرعية بشكل متكرر
async function deepDeleteButton(buttonId, client) {
    // 1. البحث عن كل الأزرار الفرعية للزر الحالي
    const subButtonsResult = await client.query('SELECT id FROM public.buttons WHERE parent_id = $1', [buttonId]);

    // 2. الخطوة التكرارية: استدعاء نفس الدالة لكل زر فرعي لحذف فروعه أولاً
    for (const subButton of subButtonsResult.rows) {
        await deepDeleteButton(subButton.id, client);
    }

    // 3. بعد حذف كل الفروع، قم بحذف الرسائل الخاصة بالزر الحالي
    await client.query('DELETE FROM public.messages WHERE button_id = $1', [buttonId]);

    // 4. وأخيراً، قم بحذف الزر الحالي نفسه
    await client.query('DELETE FROM public.buttons WHERE id = $1', [buttonId]);
}
// دالة مساعدة لنسخ زر وكل محتوياته وأزراره الفرعية بشكل متكرر
async function deepCopyButton(originalButtonId, newParentId, client) {
    // 1. جلب بيانات الزر الأصلي
    const originalButtonDetailsResult = await client.query('SELECT * FROM public.buttons WHERE id = $1', [originalButtonId]);
    if (originalButtonDetailsResult.rows.length === 0) return; // توقف إذا لم يتم العثور على الزر
    const details = originalButtonDetailsResult.rows[0];

    // 2. إنشاء نسخة جديدة من الزر في المكان الجديد
    // يتم حساب الترتيب تلقائيًا ليكون آخر زر في القسم الجديد
    const lastOrderResult = await client.query(
        'SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id ' + (newParentId ? '= $1' : 'IS NULL'),
        newParentId ? [newParentId] : []
    );
    const newOrder = lastOrderResult.rows[0].max_order + 1;

    const newButtonResult = await client.query(
        'INSERT INTO public.buttons (text, parent_id, "order", is_full_width, admin_only) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [details.text, newParentId, newOrder, details.is_full_width, details.admin_only]
    );
    const newButtonId = newButtonResult.rows[0].id;

    // 3. نسخ كل الرسائل من الزر الأصلي إلى الزر الجديد
    const messagesResult = await client.query('SELECT * FROM public.messages WHERE button_id = $1 ORDER BY "order"', [originalButtonId]);
    for (const msg of messagesResult.rows) {
        await client.query(
            'INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)',
            [newButtonId, msg.order, msg.type, msg.content, msg.caption, JSON.stringify(msg.entities || [])]
        );
    }

    // 4. البحث عن كل الأزرار الفرعية للزر الأصلي
    const subButtonsResult = await client.query('SELECT id FROM public.buttons WHERE parent_id = $1 ORDER BY "order"', [originalButtonId]);

    // 5. الخطوة التكرارية (Recursion): استدعاء نفس الدالة لكل زر فرعي
    for (const subButton of subButtonsResult.rows) {
        await deepCopyButton(subButton.id, newButtonId, client);
    }
}
// دالة لتحديث حالة المستخدم وبياناته
// دالة لتحديث حالة المستخدم وبياناته (النسخة النهائية والمحسّنة)
async function updateUserState(userId, updates) {
    const client = await getClient();
    try {
        const fieldsToUpdate = [];
        const values = [];
        let paramIndex = 1;

        // خريطة لربط أسماء الحقول في الكود بأسمائها في قاعدة البيانات
        const keyMapping = {
            state: 'state',
            stateData: 'state_data',
            currentPath: 'current_path'
        };

        for (const key in updates) {
            if (Object.prototype.hasOwnProperty.call(updates, key) && keyMapping[key]) {
                const dbKey = keyMapping[key];
                fieldsToUpdate.push(`${dbKey} = $${paramIndex++}`);
                
                if (key === 'stateData') {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        }

        if (fieldsToUpdate.length === 0) {
            return; // لا يوجد شيء لتحديثه
        }

        values.push(userId); // لإضافته في جملة WHERE
        const query = `UPDATE public.users SET ${fieldsToUpdate.join(', ')} WHERE id = $${paramIndex}`;
        
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// دالة لتتبع الرسائل المرسلة للمستخدم في وضع التعديل
async function trackSentMessages(userId, messageIds) {
    const client = await getClient();
    try {
        await client.query('UPDATE public.users SET state_data = state_data || $1 WHERE id = $2', [JSON.stringify({ messageViewIds: messageIds }), userId]);
    } finally {
        client.release();
    }
}

// دالة لتجميع ومعالجة إحصائيات الأزرار (تم التحديث لتحسب الأزرار النهائية فقط)
// دالة لتجميع ومعالجة إحصائيات الأزرار (بدون ترقيم رقمي)
// دالة لتجميع ومعالجة إحصائيات الأزرار (الإصدار النهائي بتنسيق الاقتباس فقط)
async function processAndFormatTopButtons(interval) {
    const client = await getClient();
    try {
        const escapeMarkdownV2 = (text) => {
            if (typeof text !== 'string') return '';
            return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
        };

        let title = '';
        let query;

        if (interval === 'daily') {
            title = '🏆 *الأكثر استخداماً \\(اليوم\\):*';
            query = `
                SELECT
                    b.text,
                    COUNT(l.id)::integer AS clicks_count,
                    COUNT(DISTINCT l.user_id)::integer AS unique_users
                FROM public.button_clicks_log l
                JOIN public.buttons b ON b.id = l.button_id
                WHERE (l.clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
                  AND NOT EXISTS (SELECT 1 FROM public.buttons sub WHERE sub.parent_id = b.id)
                GROUP BY b.text
                ORDER BY clicks_count DESC
                LIMIT 10;
            `;
        } else { // All-Time
            title = '🏆 *الأكثر استخداماً \\(الكلي\\):*';
            query = `
                SELECT
                    b.text,
                    (
                        (SELECT COUNT(*) FROM public.button_clicks_log l WHERE l.button_id = b.id) +
                        COALESCE((SELECT s.total_clicks FROM public.lifetime_button_stats s WHERE s.button_id = b.id), 0)
                    )::integer AS clicks_count
                FROM
                    public.buttons b
                JOIN (
                    SELECT DISTINCT button_id FROM public.button_clicks_log
                    UNION
                    SELECT DISTINCT button_id FROM public.lifetime_button_stats
                ) AS clicked_buttons ON b.id = clicked_buttons.button_id
                WHERE NOT EXISTS (SELECT 1 FROM public.buttons sub WHERE sub.parent_id = b.id)
                ORDER BY
                    clicks_count DESC
                LIMIT 10;
            `;
        }

        const { rows } = await client.query(query);
        if (rows.length === 0) return `${title}\nلا توجد بيانات لعرضها\\.`;
        
        const formattedRows = rows.map((row) => {
            let userText = '';
            if (interval === 'daily') {
                userText = `\n   \\- 👤 المستخدمون: \`${row.unique_users || 0}\``;
            }
            // ✨ التعديل هنا: إزالة النقطة \\- والإبقاء على الاقتباس > فقط
            return `> *${escapeMarkdownV2(row.text)}*\n   \\- 🖱️ الضغطات: \`${row.clicks_count}\`${userText}`;
        }).join('\n\n');

        return `${title}\n\n${formattedRows}`;
    } finally {
        client.release();
    }
}

// دالة لتحديث عرض المشرف (حذف الرسائل وإعادة إرسالها)
async function refreshAdminView(ctx, userId, buttonId, confirmationMessage = '✅ تم تحديث العرض.') {
    const client = await getClient();
    try {
        const userResult = await client.query('SELECT state_data FROM public.users WHERE id = $1', [userId]);
        const messageIdsToDelete = userResult.rows[0]?.state_data?.messageViewIds || [];
        for (const msgId of messageIdsToDelete) {
            await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
        }
        await sendButtonMessages(ctx, buttonId, true);
        await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } finally {
        client.release();
    }
}
// دالة جديدة مخصصة فقط لتحديث لوحة المفاتيح
async function refreshKeyboardView(ctx, userId, confirmationMessage) {
    try {
        await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } catch (error) {
        console.error('Error refreshing keyboard view:', error);
    }
}

async function generateKeyboard(userId) {
  const client = await getClient();
  try {
    const userResult = await client.query('SELECT is_admin, current_path, state, state_data FROM public.users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return [[]];
    const { is_admin: isAdmin, current_path: currentPath, state, state_data: stateData } = userResult.rows[0];
    let keyboardRows = [];

    // --- لوحات المفاتيح الخاصة بالحالات ---
    // ✨ التعديل هنا: إضافة حالة البث الجماعي
    if (isAdmin && state === 'AWAITING_BROADCAST_MESSAGES') {
        return [['✅ إنهاء الإضافة والبدء']];
    }
    if (state === 'AWAITING_BATCH_NUMBER' || state === 'CONTACTING_ADMIN') {
        return [['❌ إلغاء العملية']];
    }
    // ... باقي الحالات تبقى كما هي
    if (state === 'AWAITING_ALERT_MESSAGES') {
        return [['✅ إنهاء إضافة رسائل التنبيه']];
    }
    if (isAdmin && state === 'AWAITING_DEFAULT_BUTTON_NAMES') {
        return [['✅ تأكيد الأسماء والانتقال للاختيار'], ['❌ إلغاء']];
    }
    if (isAdmin && state === 'SELECTING_TARGETS_FOR_DEFAULT') {
        const selectedCount = stateData.selectedTargets?.length || 0;
        keyboardRows.unshift([`✅ إضافة للـ (${selectedCount}) قسم المحدد`, '❌ إلغاء']);
    }
    if (state === 'DYNAMIC_TRANSFER') {
        return [['✅ إنهاء وإضافة الكل', '❌ إلغاء العملية']];
    }
    if (state === 'AWAITING_BULK_MESSAGES') {
        return [['✅ إنهاء الإضافة']];
    }
    if (isAdmin && state === 'SELECTING_BUTTONS') {
        const selectedCount = stateData.selectedButtons?.length || 0;
        keyboardRows.unshift([`✅ تأكيد الاختيار (${selectedCount})`, '❌ إلغاء']);
    }
    if (isAdmin && state === 'AWAITING_DESTINATION') {
        const actionText = stateData.selectionAction === 'copy' ? '✅ النسخ إلى هنا' : '✅ النقل إلى هنا';
        keyboardRows.unshift([actionText, '❌ إلغاء']);
    }
    
    // --- لوحة مفاتيح قسم الإشراف ---
    if (currentPath === 'supervision') {
        keyboardRows = [
            // ✨ التعديل هنا: إعادة زر الرسالة الجماعية
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['🔔 رسالة التنبيه', '📝 تعديل رسالة الترحيب'],
            ['⚙️ تعديل المشرفين', '🚫 قائمة المحظورين'],
            ['🔙 رجوع', '🔝 القائمة الرئيسية']
        ];
        return keyboardRows;
    }

    // --- باقي الدالة يبقى كما هو بدون تغيير ---
    let buttonsToRender;
    let query, values;
    if (currentPath === 'root') {
        query = 'SELECT id, text, "order", is_full_width, admin_only FROM public.buttons WHERE parent_id IS NULL ORDER BY "order"';
        values = [];
    } else {
        const parentId = currentPath.split('/').pop();
        query = 'SELECT id, text, "order", is_full_width, admin_only FROM public.buttons WHERE parent_id = $1 ORDER BY "order"';
        values = [parentId];
    }
    const buttonsResult = await client.query(query, values);
    buttonsToRender = buttonsResult.rows;
    
    let currentRow = [];
    buttonsToRender.forEach(button => {
        if (!button.admin_only || isAdmin) {
            let buttonText = button.text;
            if (state === 'SELECTING_BUTTONS' && stateData.selectedButtons?.some(b => b.id === button.id)) {
                buttonText = `✅ ${button.text}`;
            }
          if (state === 'SELECTING_TARGETS_FOR_DEFAULT' && stateData.selectedTargets?.some(b => b.id === button.id)) {
                buttonText = `✅ ${button.text}`;
            }

            if (button.is_full_width) {
                if (currentRow.length > 0) keyboardRows.push(currentRow);
                keyboardRows.push([buttonText]);
                currentRow = [];
            } else {
                currentRow.push(buttonText);
                if (currentRow.length === 2) {
                    keyboardRows.push(currentRow);
                    currentRow = [];
                }
            }
        }
    });

    if (currentRow.length > 0) keyboardRows.push(currentRow);

    if (isAdmin) {
        if (isAdmin && state === 'EDITING_BUTTONS') { 
            keyboardRows.push(['➕ إضافة زر']);
            keyboardRows.push(['📥 نقل البيانات', '➕ أزرار افتراضية']);
            keyboardRows.push(['✂️ نقل أزرار', '📥 نسخ أزرار']);
        }
        const otherAdminActions = [];
        if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
            otherAdminActions.push('➕ إضافة رسالة');
        }
        if (otherAdminActions.length > 0) {
            keyboardRows.push(otherAdminActions);
        }
    }
    
    if (currentPath !== 'root') {
        keyboardRows.push(['🔙 رجوع', '🔝 القائمة الرئيسية']);
    }

    if (isAdmin) {
        const editContentText = state === 'EDITING_CONTENT' ? '🚫 إلغاء تعديل المحتوى' : '📄 تعديل المحتوى';
        const editButtonsText = state === 'EDITING_BUTTONS' ? '🚫 إلغاء تعديل الأزرار' : '✏️ تعديل الأزرار';
        keyboardRows.push([editButtonsText, editContentText]);
    }

    const finalRow = [];
    finalRow.push('💬 التواصل مع الأدمن');
    if (isAdmin && currentPath === 'root') {
        finalRow.push('👑 الإشراف');
    }
    keyboardRows.push(finalRow);

    return keyboardRows;
  } catch (error) {
    console.error('Error generating keyboard:', error);
    return [['حدث خطأ في عرض الأزرار']];
  } finally {
    client.release();
  }
}

// دالة لإرسال رسائل الزر (نسخة معدّلة)
// دالة لإرسال رسائل الزر (نسخة نهائية بمعالج تنسيق مدمج)
async function sendButtonMessages(ctx, buttonId, inEditMode = false) {
    const client = await getClient();
    try {
        const messagesResult = await client.query('SELECT id, type, content, caption, entities, "order" FROM public.messages WHERE button_id = $1 ORDER BY "order"', [buttonId]);
        const messages = messagesResult.rows;

        if (messages.length === 0 && inEditMode) {
            if (ctx.from) await trackSentMessages(String(ctx.from.id), []);
            return 0;
        }
        
        const sentMessageIds = [];

        for (const message of messages) {
            let sentMessage;
            let inlineKeyboard = [];
            
            if (inEditMode) {
                const messageId = message.id;
                const baseControls = [ Markup.button.callback('🔼', `msg:up:${messageId}`), Markup.button.callback('🔽', `msg:down:${messageId}`), Markup.button.callback('🗑️', `msg:delete:${messageId}`), Markup.button.callback('➕', `msg:addnext:${messageId}`) ];
                if (message.type === 'text') {
                    baseControls.push(Markup.button.callback('✏️', `msg:edit:${messageId}`));
                    inlineKeyboard = [ baseControls ];
                } else {
                     inlineKeyboard = [ baseControls, [ Markup.button.callback('📝 تعديل الشرح', `msg:edit_caption:${messageId}`), Markup.button.callback('🔄 استبدال الملف', `msg:replace_file:${messageId}`) ]];
                }
            }
            
            let options = {
                reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
            };
            let textToSend = message.content;

            // ==========================================================
            // |      =============== المنطق النهائي للتنسيق ===============      |
            // ==========================================================
            if (message.entities && message.entities.length > 0) {
                // إذا كانت entities موجودة (رسالة موجهة)، فهي الأولوية القصوى
                if (message.type === 'text') {
                    options.entities = message.entities;
                } else {
                    options.caption = message.caption || '';
                    options.caption_entities = message.entities;
                }
            } else {
                // إذا لم تكن entities موجودة (نص يدوي)، قم بتحويل Markdown إلى HTML وأرسل دائمًا كـ HTML
                options.parse_mode = 'HTML';
                if (message.type === 'text') {
                    textToSend = convertMarkdownToHtml(message.content);
                } else {
                    options.caption = convertMarkdownToHtml(message.caption);
                }
            }

            try {
                switch (message.type) {
                    case 'text': sentMessage = await ctx.reply(textToSend, options); break;
                    case 'photo': sentMessage = await ctx.replyWithPhoto(message.content, options); break;
                    case 'video': sentMessage = await ctx.replyWithVideo(message.content, options); break;
                    case 'document': sentMessage = await ctx.replyWithDocument(message.content, options); break;
                    case 'audio': sentMessage = await ctx.replyWithAudio(message.content, options); break;
                    case 'voice': sentMessage = await ctx.replyWithVoice(message.content, options); break;
                }
                if (sentMessage) sentMessageIds.push(sentMessage.message_id);
            } catch (e) {
                console.error(`Failed to send message ID ${message.id} (type: ${message.type}). Error:`, e.message);
            }
        }
        if(inEditMode && ctx.from) await trackSentMessages(String(ctx.from.id), sentMessageIds);
        return messages.length;
    } finally {
        client.release();
    }
}

// دالة لتسجيل إحصائيات ضغط الزر
// دالة لتسجيل إحصائيات ضغط الزر
async function updateButtonStats(buttonId, userId) {
    const client = await getClient();
    try {
        // تم إضافة حقل clicked_at لتسجيل وقت الضغطة
        const query = 'INSERT INTO public.button_clicks_log (button_id, user_id, clicked_at) VALUES ($1, $2, NOW())';
        const values = [buttonId, userId];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// =================================================================
// |                       Bot Commands & Logic                      |
// =================================================================

bot.start(async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        const userExists = userResult.rows.length > 0;
        
        const adminsResult = await client.query('SELECT array_agg(id) FROM public.users WHERE is_admin = true');
        const adminIds = adminsResult.rows[0]?.array_agg || [];
        const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
        const isAdmin = adminIds.includes(userId) || isSuperAdmin;
        
        if (!userExists) {
            const query = 'INSERT INTO public.users (id, chat_id, is_admin, current_path, state, state_data, last_active, banned) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
            const values = [userId, ctx.chat.id, isAdmin, 'root', 'NORMAL', {}, new Date(), false];
            await client.query(query, values);
            
            // Notification logic (requires a settings table or similar)
            if (adminIds.length > 0) {
                const totalUsersResult = await client.query('SELECT COUNT(*) FROM public.users');
                const totalUsers = totalUsersResult.rows[0].count;

                const user = ctx.from;
                const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                const userLink = `tg://user?id=${user.id}`;
                const language = user.language_code || 'غير محدد';
                const isPremium = user.is_premium ? 'نعم ✅' : 'لا ❌';

                let notificationMessage = `👤 <b>مستخدم جديد انضم!</b>\n\n` +
                                          `<b>الاسم:</b> <a href="${userLink}">${userName}</a>\n` +
                                          `<b>المعرف:</b> ${user.username ? `@${user.username}` : 'لا يوجد'}\n` +
                                          `<b>ID:</b> <code>${user.id}</code>\n` +
                                          `<b>لغة التلجرام:</b> ${language}\n` +
                                          `<b>حساب بريميوم:</b> ${isPremium}\n\n` +
                                          `👥 أصبح العدد الكلي للمستخدمين: <b>${totalUsers}</b>`;

                for (const adminId of adminIds) {
                    try { await bot.telegram.sendMessage(adminId, notificationMessage, { parse_mode: 'HTML' }); }
                    catch (e) { console.error(`Failed to send new user notification to admin ${adminId}:`, e.message); }
                }
            }
        } else {
            const query = 'UPDATE public.users SET current_path = $1, state = $2, state_data = $3, last_active = $4, is_admin = $5 WHERE id = $6';
            const values = ['root', 'NORMAL', {}, new Date(), isAdmin, userId];
            await client.query(query, values);
        }

        const settingsResult = await client.query('SELECT welcome_message FROM public.settings WHERE id = 1');
        const welcomeMessage = settingsResult.rows[0]?.welcome_message || 'أهلاً بك في البوت!';
        await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } catch (error) { console.error("FATAL ERROR in bot.start:", error, "Update:", ctx.update); }
    finally { client.release(); }
});

// --- أوامر الإدارة الجديدة (حظر، فك حظر، معلومات) ---

// دالة مساعدة للتعامل مع الحظر وفك الحظر
// --- دالة مساعدة للتعامل مع الحظر وفك الحظر (تدعم الطريقتين) ---
const banUnbanHandler = async (ctx, banAction) => {
    const client = await getClient();
    try {
        const adminId = String(ctx.from.id);
        const adminResult = await client.query('SELECT is_admin FROM public.users WHERE id = $1', [adminId]);
        if (!adminResult.rows[0]?.is_admin) return; // الأمر للمشرفين فقط

        let targetId = null;
        let targetName = null;

        // ✨ الخطوة 1: التحقق من طريقة الرد على رسالة موجهة
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.forward_from) {
            const targetUser = ctx.message.reply_to_message.forward_from;
            targetId = String(targetUser.id);
            targetName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim();
        } 
        // ✨ الخطوة 2: إذا لم تكن الطريقة الأولى، تحقق من وجود ID في الأمر
        else {
            const parts = ctx.message.text.split(' ');
            if (parts.length > 1 && /^\d+$/.test(parts[1])) {
                targetId = parts[1];
                try {
                    const userChat = await bot.telegram.getChat(targetId);
                    targetName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                } catch (e) {
                    targetName = `<code>${targetId}</code>`; // في حالة عدم العثور على المستخدم، استخدم الـ ID
                }
            }
        }

        // ✨ الخطوة 3: إذا لم يتم تحديد هدف، أرسل رسالة تعليمات
        if (!targetId) {
            const command = banAction ? '/ban' : '/unban';
            return ctx.replyWithHTML(`⚠️ <b>استخدام غير صحيح.</b>\n\nيمكنك استخدام الأمر بطريقتين:\n1️⃣ قم بالرد على رسالة مُعادة توجيهها من المستخدم بالأمر <code>${command}</code>.\n2️⃣ اكتب الأمر مع ID المستخدم، مثال: <code>${command} 123456789</code>.`);
        }

        if (targetId === process.env.SUPER_ADMIN_ID) {
            return ctx.reply('🚫 لا يمكن تعديل حالة الأدمن الرئيسي.');
        }

        await client.query('UPDATE public.users SET banned = $1 WHERE id = $2', [banAction, targetId]);
        
        if (banAction) {
            await ctx.replyWithHTML(`🚫 تم حظر المستخدم <b>${targetName}</b> بنجاح.`);
            await bot.telegram.sendMessage(targetId, '🚫 لقد تم حظرك من استخدام هذا البوت.').catch(e => console.error(e.message));
        } else {
            await ctx.replyWithHTML(`✅ تم فك حظر المستخدم <b>${targetName}</b> بنجاح.`);
            await bot.telegram.sendMessage(targetId, '✅ تم فك الحظر عنك. يمكنك الآن استخدام البوت مجددًا.').catch(e => console.error(e.message));
        }

    } catch (error) {
        console.error('Error in ban/unban command:', error);
        await ctx.reply('حدث خطأ أثناء تنفيذ الأمر.');
    } finally {
        client.release();
    }
};

bot.command('ban', (ctx) => banUnbanHandler(ctx, true));
bot.command('unban', (ctx) => banUnbanHandler(ctx, false));

// أمر عرض معلومات المستخدم (يدعم الآن الرد أو استخدام الـ ID)
bot.command('info', async (ctx) => {
    const client = await getClient();
    try {
        const adminId = String(ctx.from.id);
        const userResult = await client.query('SELECT is_admin FROM public.users WHERE id = $1', [adminId]);
        if (!userResult.rows[0]?.is_admin) {
            return; // ليس مشرفًا
        }

        let targetUser = null;
        let targetId = null;
        let targetName = null;
        let targetUsername = null;

        // الطريقة الأولى: التحقق من الرد على رسالة موجهة
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.forward_from) {
            targetUser = ctx.message.reply_to_message.forward_from;
            targetId = String(targetUser.id);
        } 
        // الطريقة الثانية: التحقق من وجود ID في نص الأمر
        else {
            const parts = ctx.message.text.split(' ');
            if (parts.length > 1 && /^\d+$/.test(parts[1])) {
                targetId = parts[1];
            }
        }

        // إذا لم يتم تحديد هدف بأي من الطريقتين، أرسل رسالة تعليمات
        if (!targetId) {
            return ctx.replyWithHTML(
                '⚠️ <b>استخدام غير صحيح.</b>\n\n' +
                'يمكنك استخدام الأمر بطريقتين:\n' +
                '1️⃣ قم بالرد على رسالة مُعادة توجيهها من المستخدم بالأمر <code>/info</code>.\n' +
                '2️⃣ اكتب الأمر مع ID المستخدم، مثال: <code>/info 123456789</code>.'
            );
        }

        // جلب بيانات المستخدم بناءً على الـ ID
        // إذا كانت لدينا بيانات المستخدم من الرسالة الموجهة نستخدمها، وإلا نجلبها عبر API
        if (targetUser) {
            targetName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim();
            targetUsername = targetUser.username ? `@${targetUser.username}` : 'لا يوجد';
        } else {
            try {
                const userChat = await bot.telegram.getChat(targetId);
                targetName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                targetUsername = userChat.username ? `@${userChat.username}` : 'لا يوجد';
            } catch (e) {
                targetName = 'مستخدم غير معروف';
                targetUsername = 'لا يمكن جلبه';
                console.error(`Could not fetch info for user ${targetId}:`, e.message);
            }
        }

        // استكمال جلب باقي البيانات من قاعدة البيانات
        const [
            botUserResult,
            clicksTodayResult,
            buttonsVisitedResult
        ] = await Promise.all([
            client.query('SELECT last_active FROM public.users WHERE id = $1', [targetId]),
            client.query(`
                SELECT COUNT(*) FROM public.button_clicks_log 
                WHERE user_id = $1 AND (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
            `, [targetId]),
            client.query(`
                SELECT b.text, COUNT(l.id) as click_count
                FROM public.buttons b 
                JOIN public.button_clicks_log l ON b.id = l.button_id 
                WHERE l.user_id = $1 AND (l.clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
                GROUP BY b.text
                ORDER BY click_count DESC
            `, [targetId])
        ]);

        const lastActive = botUserResult.rows[0]?.last_active;        const clicksToday = clicksTodayResult.rows[0]?.count || 0;
        
        const buttonsVisited = buttonsVisitedResult.rows.length > 0 
            ? buttonsVisitedResult.rows.map(r => `- ${r.text} (${r.click_count} ضغطة)`).join('\n\n') 
            : 'لم يزر أي أزرار اليوم';
        
        const lastActiveFormatted = lastActive 
            ? new Date(lastActive).toLocaleString('ar-EG', {
                timeZone: 'Africa/Cairo',
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            })
            : 'غير معروف';

        // بناء التقرير النهائي
        const userInfoReport = `📋 <b>تقرير المستخدم: ${targetName}</b>\n\n` +
                             `<b>المعرف:</b> ${targetUsername} (<code>${targetId}</code>)\n\n` +
                             `🕒 <b>آخر نشاط:</b> ${lastActiveFormatted}\n\n` +
                             `🖱️ <b>إجمالي الضغطات (اليوم):</b> ${clicksToday}\n\n` +
                             `🔘 <b>تفاصيل نشاط الأزرار (اليوم):</b>\n\n` +
                             `${buttonsVisited}`;

        await ctx.replyWithHTML(userInfoReport);

    } catch (error) {
        console.error("Error in /info command:", error);
        await ctx.reply('حدث خطأ أثناء جلب بيانات المستخدم.');
    } finally {
        client.release();
    }
});
const mainMessageHandler = async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return bot.start(ctx);

        const { current_path: currentPath, state, is_admin: isAdmin, state_data: stateData, banned } = userResult.rows[0];
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');

        await client.query('UPDATE public.users SET last_active = NOW() WHERE id = $1', [userId]);

      // ... بعد سطر تحديث آخر نشاط

            // =================================================================
            // |      منطق تجميع رسائل البث الجماعي (النسخة النهائية)            |
            // =================================================================
            if (isAdmin && state === 'AWAITING_BROADCAST_MESSAGES') {
                const { collectedMessages = [] } = stateData;

                // --- 1. التعامل مع زر الإنهاء ---
                if (ctx.message && ctx.message.text === '✅ إنهاء الإضافة والبدء') {
                    if (collectedMessages.length === 0) {
                        await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                        return ctx.reply('تم إلغاء العملية لعدم إضافة أي رسائل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                    }

                    const statusMessage = await ctx.reply('⏳ جارٍ تسجيل حزمة الرسائل وإرسالها للمعالجة...');
                    
                    try {
                        const jobData = { messages: collectedMessages };

                        const insertQuery = `
                            INSERT INTO public.background_jobs (job_type, job_data, triggered_by_user_id)
                            VALUES ('broadcast', $1::jsonb, $2)
                            RETURNING id;
                        `;
                        const result = await client.query(insertQuery, [JSON.stringify(jobData), userId]);
                        const jobId = result.rows[0].id;

                        await axios.post(process.env.GOOGLE_SCRIPT_URL, { jobId });
                        
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined,
                            `✅ تم بدء عملية بث ${collectedMessages.length} رسالة في الخلفية. سيصلك تقرير عند الانتهاة.`
                        );

                    } catch (error) {
                        console.error("Error starting multi-message broadcast job:", error);
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined,
                            '❌ حدث خطأ أثناء محاولة بدء مهمة البث.'
                        );
                    } finally {
                        await updateUserState(userId, { state: 'NORMAL' });
                        await refreshKeyboardView(ctx, userId, 'تم الرجوع للوضع الطبيعي.');
                    }
                    return; 
                }

                // --- 2. تجميع الرسائل الواردة ---
               // --- 2. تجميع الرسائل الواردة ---
let newMessageObject;
if (ctx.message.poll) {
    try {
        const originalPoll = ctx.message.poll;

        // نجعل البوت ينشئ استطلاعًا جديدًا بناءً على بيانات الاستطلاع الأصلي
        const botOwnedPoll = await ctx.replyWithPoll(
            originalPoll.question,
            originalPoll.options.map(option => option.text),
            {
                is_anonymous: originalPoll.is_anonymous,
                type: originalPoll.type,
                allows_multiple_answers: originalPoll.allows_multiple_answers,
                correct_option_id: originalPoll.correct_option_id,
                explanation: originalPoll.explanation,
                explanation_entities: originalPoll.explanation_entities,
                open_period: originalPoll.open_period,
                close_date: originalPoll.close_date,
                is_closed: originalPoll.is_closed
            }
        );
        
        // الآن نخزن بيانات الاستطلاع الجديد الذي أنشأه البوت
        newMessageObject = {
            type: "poll",
            content: String(botOwnedPoll.message_id), // ID رسالة الاستطلاع الجديد
            caption: String(botOwnedPoll.chat.id),    // ID المحادثة (نفس المحادثة الحالية)
            entities: []
        };

    } catch (e) {
        console.error("Failed to create and handle poll:", e);
        return ctx.reply('حدث خطأ فادح أثناء إنشاء الاستطلاع. يرجى التحقق من صلاحيات البوت.');
    }
}
// ... باقي الكود
                else if (ctx.message.text) {
                    newMessageObject = { type: "text", content: ctx.message.text, entities: ctx.message.entities || [] };
                } else if (ctx.message.photo) {
                    newMessageObject = { type: "photo", content: ctx.message.photo.pop().file_id, caption: ctx.message.caption || '', entities: ctx.message.caption_entities || [] };
                } else if (ctx.message.video) {
                    newMessageObject = { type: "video", content: ctx.message.video.file_id, caption: ctx.message.caption || '', entities: ctx.message.caption_entities || [] };
                } else if (ctx.message.document) {
                    newMessageObject = { type: "document", content: ctx.message.document.file_id, caption: ctx.message.caption || '', entities: ctx.message.caption_entities || [] };
                } else if (ctx.message.audio) {
                    newMessageObject = { type: "audio", content: ctx.message.audio.file_id, caption: ctx.message.caption || '', entities: ctx.message.caption_entities || [] };
                } else if (ctx.message.voice) {
                    newMessageObject = { type: "voice", content: ctx.message.voice.file_id, caption: ctx.message.caption || '', entities: ctx.message.caption_entities || [] };
                } else { 
                    return ctx.reply("⚠️ نوع الرسالة غير مدعوم للبث الجماعي.");
                }

                const updatedCollectedMessages = [...collectedMessages, newMessageObject];
                await updateUserState(userId, { stateData: { collectedMessages: updatedCollectedMessages } });
                
                await ctx.reply(`👍 تمت إضافة الرسالة (${updatedCollectedMessages.length}). أرسل المزيد أو اضغط على زر الإنهاء.`);
                return;
            }
            // --- انتهاء منطق تجميع الرسائل ---
        // =================================================================
        // |               منطق عرض رسالة التنبيه (النسخة النهائية)             |
        // =================================================================
        try {
            const settingsResult = await client.query('SELECT alert_message, alert_message_set_at, alert_duration_hours FROM public.settings WHERE id = 1');
            const alert = settingsResult.rows[0];
            if (alert && Array.isArray(alert.alert_message) && alert.alert_message.length > 0 && alert.alert_message_set_at) {
                const alertSetAt = new Date(alert.alert_message_set_at);
                const expiresAt = new Date(alertSetAt.getTime() + alert.alert_duration_hours * 60 * 60 * 1000);
                const userLastSeen = userResult.rows[0].last_alert_seen_at;

                if (new Date() < expiresAt && (!userLastSeen || new Date(userLastSeen) < alertSetAt)) {
                    const introMessage = await ctx.reply('🔔 **تنبيه هام من الإدارة** 🔔', { parse_mode: 'Markdown' });
                    await ctx.telegram.pinChatMessage(ctx.chat.id, introMessage.message_id).catch(e => console.error("Failed to pin message:", e.message));
                    await client.query('UPDATE public.users SET pinned_alert_id = $1 WHERE id = $2', [introMessage.message_id, userId]);

                    // استبدل حلقة for القديمة بهذه
                    for (const messageObject of alert.alert_message) {
                        // نتحقق إذا كانت الرسالة استطلاعاً أم لا
                        if (messageObject.is_poll) {
                            // للاستطلاعات: يجب استخدام forward لجمع النتائج
                            await bot.telegram.forwardMessage(
                                ctx.chat.id,
                                messageObject.from_chat_id,
                                messageObject.message_id
                            ).catch(e => console.error(`Failed to FORWARD poll alert:`, e.message));
                        } else {
                            // لباقي الرسائل: نستخدم copy لإخفاء اسم المرسل
                            await bot.telegram.copyMessage(
                                ctx.chat.id,
                                messageObject.from_chat_id,
                                messageObject.message_id
                            ).catch(e => console.error(`Failed to COPY alert message:`, e.message));
                        }
                    }

                    await client.query('UPDATE public.users SET last_alert_seen_at = NOW() WHERE id = $1', [userId]);
                    return;
                }
            }
        } catch (e) {
            console.error("Error handling alert message:", e);
        }

      // ==========================================================
// |      =============== منطق الأزرار الافتراضية (استقبال الأسماء) يبدأ هنا ===============      |
// ==========================================================
if (isAdmin && state === 'AWAITING_DEFAULT_BUTTON_NAMES') {
    if (!ctx.message || !ctx.message.text) return;
    const text = ctx.message.text;

    if (text === '❌ إلغاء') {
        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
        return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
    }
    
    if (text === '✅ تأكيد الأسماء والانتقال للاختيار') {
        const defaultButtonNames = stateData.defaultButtonNames;
        if (!defaultButtonNames || defaultButtonNames.length === 0) {
            return ctx.reply('⚠️ لم تقم بإدخال أي أسماء. أرسل الأسماء أولاً.');
        }

        await updateUserState(userId, {
            state: 'SELECTING_TARGETS_FOR_DEFAULT',
            stateData: { defaultButtonNames, selectedTargets: [] }
        });
        return ctx.reply(
            `👍 تم حفظ ${defaultButtonNames.length} اسم.\n\n` +
            '**الخطوة التالية:**\n' +
            'تنقل الآن في البوت واختر الأقسام الرئيسية التي تريد إضافة هذه الأزرار بداخلها. عند الانتهاء، اضغط على زر التأكيد في الأعلى.',
            { parse_mode: 'Markdown', ...Markup.keyboard(await generateKeyboard(userId)).resize() }
        );
    }

    // إذا لم يكن أمرًا، اعتبره قائمة الأسماء
    const buttonNames = text.split('\n').map(name => name.trim()).filter(name => name);
    await updateUserState(userId, { stateData: { ...stateData, defaultButtonNames: buttonNames } });
    return ctx.reply(`✅ تم استلام ${buttonNames.length} اسم. اضغط على زر التأكيد في الأسفل للمتابعة.`, Markup.keyboard(await generateKeyboard(userId)).resize());
}
if (isAdmin && state === 'SELECTING_BUTTONS') {
    if (!ctx.message || !ctx.message.text) return;
    let text = ctx.message.text;

    const currentParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
    const buttonNameToFind = text.startsWith('✅ ') ? text.substring(2) : text;
    
    let buttonResult;
    if (currentParentId === null) {
        buttonResult = await client.query('SELECT id, text FROM public.buttons WHERE parent_id IS NULL AND text = $1', [buttonNameToFind]);
    } else {
        buttonResult = await client.query('SELECT id, text FROM public.buttons WHERE parent_id = $1 AND text = $2', [currentParentId, buttonNameToFind]);
    }

    if (buttonResult.rows.length > 0) {
        const clickedButton = buttonResult.rows[0];
        let selectedButtons = stateData.selectedButtons || [];
        const buttonIndex = selectedButtons.findIndex(b => b.id === clickedButton.id);

        let feedbackMessage;
        if (buttonIndex > -1) {
            selectedButtons.splice(buttonIndex, 1);
            feedbackMessage = `❌ تم إلغاء تحديد الزر: "${clickedButton.text}"`;
        } else {
            selectedButtons.push(clickedButton);
            feedbackMessage = `✅ تم تحديد الزر: "${clickedButton.text}"`;
        }

        await updateUserState(userId, { stateData: { ...stateData, selectedButtons } });
        await refreshKeyboardView(ctx, userId, feedbackMessage);
        return;
    }
}
// ==========================================================
// |      ================ منطق اختيار الأزرار ينتهي هنا ===============      |
// ==========================================================
// ==========================================================
// |      =============== منطق الأزرار الافتراضية (اختيار الأهداف) يبدأ هنا ===============      |
// ==========================================================
if (isAdmin && state === 'SELECTING_TARGETS_FOR_DEFAULT') {
    if (!ctx.message || !ctx.message.text) return;
    let text = ctx.message.text;
    
    // --- 1. التعامل مع أوامر الإلغاء والتأكيد ---
    if (text === '❌ إلغاء') {
        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
        return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
    }
    
    if (text.startsWith('✅ إضافة للـ')) {
        const { defaultButtonNames, selectedTargets } = stateData;

        if (!selectedTargets || selectedTargets.length === 0) {
            return ctx.reply('⚠️ لم تختر أي قسم لإضافة الأزرار إليه.');
        }

        const statusMessage = await ctx.reply(`⏳ جارٍ إضافة ${defaultButtonNames.length} زر افتراضي إلى ${selectedTargets.length} قسم...`);
        let totalAdded = 0;
        let errors = [];

        try {
            await client.query('BEGIN'); // بدء transaction
            for (const target of selectedTargets) {
                const parentId = target.id;
                const lastOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id = $1', [parentId]);
                let lastOrder = lastOrderResult.rows[0].max_order;

                for (const newButtonName of defaultButtonNames) {
                    // تحقق من عدم وجود زر بنفس الاسم في نفس القسم
                    const existingButton = await client.query('SELECT id FROM public.buttons WHERE parent_id = $1 AND text = $2', [parentId, newButtonName]);
                    if (existingButton.rows.length === 0) {
                        lastOrder++;
                        await client.query('INSERT INTO public.buttons (text, parent_id, "order", is_full_width) VALUES ($1, $2, $3, $4)', [newButtonName, parentId, lastOrder, true]);
                        totalAdded++;
                    }
                }
            }
            await client.query('COMMIT'); // تأكيد التغييرات
        } catch (e) {
            await client.query('ROLLBACK'); // تراجع في حالة حدوث خطأ
            console.error("Error adding default buttons:", e);
            errors.push("حدث خطأ في قاعدة البيانات.");
        }

        let summary = `🎉 **اكتملت العملية** 🎉\n\nتمت إضافة ${totalAdded} زر بنجاح.\n`;
        if (errors.length > 0) {
            summary += `\n⚠️ حدثت أخطاء:\n- ${errors.join('\n- ')}`;
        }

        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, summary, { parse_mode: 'Markdown' });
        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
        await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');
        return;
    }

    // --- 2. التعامل مع اختيار الأقسام ---
    const currentParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
    const buttonNameToFind = text.startsWith('✅ ') ? text.substring(2) : text;
    
    let buttonResult;
    if (currentParentId === null) {
        buttonResult = await client.query('SELECT id, text FROM public.buttons WHERE parent_id IS NULL AND text = $1', [buttonNameToFind]);
    } else {
        buttonResult = await client.query('SELECT id, text FROM public.buttons WHERE parent_id = $1 AND text = $2', [currentParentId, buttonNameToFind]);
    }

    if (buttonResult.rows.length > 0) {
        const clickedButton = buttonResult.rows[0];
        let selectedTargets = stateData.selectedTargets || [];
        const buttonIndex = selectedTargets.findIndex(b => b.id === clickedButton.id);

        let feedbackMessage;
        if (buttonIndex > -1) {
            selectedTargets.splice(buttonIndex, 1);
            feedbackMessage = `❌ تم إلغاء تحديد القسم: "${clickedButton.text}"`;
        } else {
            selectedTargets.push(clickedButton);
            feedbackMessage = `✅ تم تحديد القسم: "${clickedButton.text}"`;
        }

        await updateUserState(userId, { stateData: { ...stateData, selectedTargets } });
        await refreshKeyboardView(ctx, userId, feedbackMessage);
        return;
    }
}
// ... يستمر الكود القديم الخاص بـ DYNAMIC_TRANSFER وباقي الحالات
// ==========================================================
// |      =============== الكود المحدث والنهائي يبدأ هنا ===============      |
// ==========================================================
if (isAdmin && state === 'DYNAMIC_TRANSFER') {
    // --- التحقق من أوامر الإنهاء والإلغاء أولاً ---
    if (ctx.message && ctx.message.text) {
        if (ctx.message.text === '✅ إنهاء وإضافة الكل') {
            let finalUnits = [...(stateData.completedUnits || [])];
            // **تعديل 1**: إضافة الزر الأخير حتى لو كان فارغاً
            if (stateData.currentButton) {
                finalUnits.push(stateData.currentButton);
                 await ctx.reply(`🔔 **اكتمل بناء الزر الأخير!**\n- الزر: \`${stateData.currentButton.name}\`\n- المحتوى: \`${stateData.currentButton.content.length}\` رسالة.`, { parse_mode: 'Markdown' });
            }

            if (finalUnits.length === 0) {
                 await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                return ctx.reply('لم يتم بناء أي أزرار مكتملة. تم الخروج من وضع النقل.', Markup.keyboard(await generateKeyboard(userId)).resize());
            }

            const statusMessage = await ctx.reply(`⏳ جاري إضافة ${finalUnits.length} زر مع محتوياتها إلى قاعدة البيانات...`);

            const parentId = currentPath === 'root' ? null : currentPath.split('/').pop();
            const lastOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL'), parentId ? [parentId] : []);
            let btnOrder = lastOrderResult.rows[0].max_order;

            for (const unit of finalUnits) {
                btnOrder++;
                const insertResult = await client.query('INSERT INTO public.buttons (text, parent_id, "order", is_full_width) VALUES ($1, $2, $3, $4) RETURNING id', [unit.name, parentId, btnOrder, true]);
                const newButtonId = insertResult.rows[0].id;
                
                let msgOrder = -1;
                for (const msg of unit.content) {
                    msgOrder++;
                    await client.query('INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)', [newButtonId, msgOrder, msg.type, msg.content, msg.caption, JSON.stringify(msg.entities)]);
                }
            }
            
            await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `🎉 اكتملت العملية! تم إضافة ${finalUnits.length} زر بنجاح.`);
            await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
            await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');
            return;
        }
        if (ctx.message.text === '❌ إلغاء العملية') {
            await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
            return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
        }
    }
    
    const step = stateData.step;

    if (step === 'AWAITING_BUTTON_SOURCE') {
        const buttonSourceId = getSourceId(ctx);
        if (!buttonSourceId) return ctx.reply('⚠️ خطأ: يرجى إعادة توجيه رسالة صالحة.');
        
        await updateUserState(userId, { stateData: { ...stateData, step: 'AWAITING_CONTENT_SOURCE', buttonSourceId } });
        // **تعديل 2**: إضافة parse_mode
        return ctx.reply('✅ تم تحديد مصدر الأزرار.\n\n**الخطوة 2:** الآن قم بتوجيه رسالة من **مصدر المحتوى**.', { parse_mode: 'Markdown' });
    }

    if (step === 'AWAITING_CONTENT_SOURCE') {
        const contentSourceId = getSourceId(ctx);
        if (!contentSourceId) return ctx.reply('⚠️ خطأ: يرجى إعادة توجيه رسالة صالحة.');

        await updateUserState(userId, { 
            stateData: { ...stateData, step: 'AWAITING_NEXT_BUTTON', contentSourceId } 
        });
        // **تعديل 2**: إضافة parse_mode
        return ctx.reply('✅ تم تحديد مصدر المحتوى.\n\n**🚀 أنت الآن جاهز!**\nابدأ الآن بتوجيه أول رسالة من **مصدر الزر** لبدء العملية.', { parse_mode: 'Markdown' });
    }

    if (step === 'AWAITING_NEXT_BUTTON' || step === 'AWAITING_CONTENT') {
        const sourceId = getSourceId(ctx);
        if (!sourceId) return;
        
        if (sourceId === stateData.buttonSourceId) {
            const buttonName = ctx.message.text || ctx.message.caption;
            if (!buttonName) return ctx.reply('⚠️ تم تجاهل رسالة الزر، لا تحتوي على نص أو تعليق.');

            let updatedUnits = [...(stateData.completedUnits || [])];

            // **تعديل 1**: إزالة شرط وجود المحتوى، سيتم حفظ الزر السابق دائمًا
            if (stateData.currentButton) {
                const prevButton = stateData.currentButton;
                updatedUnits.push(prevButton);
                // **تعديل 2**: إضافة parse_mode
                await ctx.reply(`🔔 **اكتمل بناء الزر السابق!**\n- الزر: \`${prevButton.name}\`\n- المحتوى: \`${prevButton.content.length}\` رسالة.\n\n✅ تم حفظه مؤقتاً.`, { parse_mode: 'Markdown' });
            }

            const newButton = { name: buttonName, content: [] };
            
            await updateUserState(userId, { 
                stateData: { ...stateData, step: 'AWAITING_CONTENT', completedUnits: updatedUnits, currentButton: newButton }
            });
            // **تعديل 2**: إضافة parse_mode
            return ctx.reply(`👍 تم استلام الزر **"${buttonName}"**. الآن قم بتوجيه رسائل المحتوى الخاصة به.`, { parse_mode: 'Markdown' });
        }

        if (sourceId === stateData.contentSourceId) {
            if (step !== 'AWAITING_CONTENT' || !stateData.currentButton) {
                return ctx.reply('⚠️ خطأ: يجب أن تبدأ بزر أولاً. قم بتوجيه رسالة من مصدر الأزرار.');
            }
            
            let type, content, caption = '', entities = [];
            if (ctx.message.text) { type = "text"; content = ctx.message.text; entities = ctx.message.entities || []; }
            else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
            else if (ctx.message.video) { type = "video"; content = ctx.message.video.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
            else if (ctx.message.document) { type = "document"; content = ctx.message.document.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
            else { return ctx.reply('⚠️ نوع رسالة المحتوى غير مدعوم حاليًا.'); }
            
            const messageObject = { type, content, caption, entities: entities || [] };
            const updatedContent = [...stateData.currentButton.content, messageObject];
            const updatedButton = { ...stateData.currentButton, content: updatedContent };

            await updateUserState(userId, { stateData: { ...stateData, currentButton: updatedButton } });
            await ctx.reply(`📥 تمت إضافة المحتوى (${updatedContent.length}) للزر النشط.`);
            return;
        }
    }
    return;
}
// ==========================================================
// |      ================ الكود المحدث والنهائي ينتهي هنا ===============      |
// ==========================================================
      if (isAdmin && state === 'AWAITING_ALERT_MESSAGES') {
            // أولاً، تحقق دائمًا من أمر الإنهاء
            if (ctx.message && ctx.message.text === '✅ إنهاء إضافة رسائل التنبيه') {
                const { collectedMessages = [] } = stateData;
                if (collectedMessages.length === 0) {
                    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                    return ctx.reply('تم إلغاء العملية لعدم إضافة رسائل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                await updateUserState(userId, { state: 'AWAITING_ALERT_DURATION', stateData: { alertMessages: collectedMessages } });
                return ctx.reply(`👍 تم تجميع ${collectedMessages.length} رسالة. الآن أدخل مدة صلاحية التنبيه بالساعات (مثال: 6).`);
            }

            // ثانيًا، إذا كانت الرسالة استطلاعًا مباشرًا
           // ثانيًا، إذا كانت الرسالة استطلاعًا مباشرًا
            if (ctx.message && ctx.message.poll && !ctx.message.forward_from && !ctx.message.forward_from_chat) {
                try {
                    // 1. Bot copies the poll to the current chat to get a stable reference.
                    const copiedMessage = await ctx.copyMessage(ctx.chat.id);
                    const { collectedMessages = [] } = stateData;
                    
                    const messageObject = {
                        is_poll: true,
                        // 2. Use the current chat ID.
                        from_chat_id: ctx.chat.id, 
                        // 3. Use the message ID of the NEWLY copied message.
                        message_id: copiedMessage.message_id 
                    };

                    const updatedMessages = [...collectedMessages, messageObject];
                    await updateUserState(userId, { stateData: { collectedMessages: updatedMessages } });
                    
                    await ctx.reply(`✅ تم اعتماد نسخة الاستطلاع التي أنشأها البوت (${updatedMessages.length}). أرسل المزيد أو اضغط "إنهاء".`);
                
                } catch(e) {
                    console.error("Failed to handle and copy poll:", e); // Updated error message for clarity
                    await ctx.reply('حدث خطأ أثناء معالجة الاستطلاع.');
                }
                return; 
            }

            // ثالثًا، إذا كانت الرسالة أي شيء آخر
            if (ctx.message) {
                const { collectedMessages = [] } = stateData;
                const messageObject = {
                    is_poll: false,
                    from_chat_id: ctx.chat.id,
                    message_id: ctx.message.message_id
                };
                const updatedMessages = [...collectedMessages, messageObject];
                await updateUserState(userId, { stateData: { collectedMessages: updatedMessages } });
                await ctx.reply(`📥 تم حفظ الرسالة (${updatedMessages.length}). أرسل المزيد أو اضغط "إنهاء".`);
                return;
            }
            return;
        }

        if (isAdmin && state === 'AWAITING_ALERT_DURATION') {
            const duration = parseInt(ctx.message.text);
            if (isNaN(duration) || duration <= 0) return ctx.reply('⚠️ يرجى إدخال رقم صحيح أكبر من صفر.');
            const { alertMessages } = stateData;
            await client.query(
                `INSERT INTO public.settings (id, alert_message, alert_message_set_at, alert_duration_hours) VALUES (1, $1, NOW(), $2) ON CONFLICT (id) DO UPDATE SET alert_message = EXCLUDED.alert_message, alert_message_set_at = EXCLUDED.alert_message_set_at, alert_duration_hours = EXCLUDED.alert_duration_hours`,
                [JSON.stringify(alertMessages), duration]
            );
            await updateUserState(userId, { state: 'NORMAL', currentPath: 'supervision' });
            return ctx.reply(`✅ تم تفعيل التنبيه بنجاح لمدة ${duration} ساعة.`, Markup.keyboard(await generateKeyboard(userId)).resize());
        }
      
        if (state === 'AWAITING_BULK_MESSAGES') {
            const { buttonId, collectedMessages = [] } = stateData;

            if (ctx.message && ctx.message.text === '✅ إنهاء الإضافة') {
                if (collectedMessages.length === 0) {
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply('تم إلغاء العملية حيث لم يتم إضافة أي رسائل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }

                // Insert collected messages into the database
                for (const msg of collectedMessages) {
                    const orderResult = await client.query('SELECT COALESCE(MAX("order"), -1) FROM public.messages WHERE button_id = $1', [buttonId]);
                    const newOrder = orderResult.rows[0].coalesce + 1;
                    const query = 'INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)';
                    const values = [buttonId, newOrder, msg.type, msg.content, msg.caption, JSON.stringify(msg.entities)];
                    await client.query(query, values);
                }
                
                await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                await refreshAdminView(ctx, userId, buttonId, `✅ تم إضافة ${collectedMessages.length} رسالة بنجاح.`);
                return;
            }

            let type, content, caption, entities;

            if (ctx.message.text) {
                type = "text";
                content = ctx.message.text;
                caption = "";
                entities = ctx.message.entities || [];
            } else if (ctx.message.photo) {
                type = "photo";
                content = ctx.message.photo.pop().file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.video) {
                type = "video";
                content = ctx.message.video.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.document) {
                type = "document";
                content = ctx.message.document.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.audio) {
                type = "audio";
                content = ctx.message.audio.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.audio.caption_entities || [];
            } else if (ctx.message.voice) {
                type = "voice";
                content = ctx.message.voice.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.voice.caption_entities || [];
            } else { 
                return ctx.reply("⚠️ نوع الرسالة غير مدعوم.");
            }

            const newMessageObject = { type, content, caption, entities };
            const updatedCollectedMessages = [...collectedMessages, newMessageObject];
            
            await updateUserState(userId, { state: 'AWAITING_BULK_MESSAGES', stateData: { buttonId, collectedMessages: updatedCollectedMessages } });
            await ctx.reply(
    `👍 تمت إضافة الرسالة (${updatedCollectedMessages.length}). أرسل المزيد أو اضغط "إنهاء الإضافة".`,
    Markup.keyboard(await generateKeyboard(userId)).resize()
);
            return;
        }

        if (isAdmin && state !== 'NORMAL' && state !== 'EDITING_BUTTONS' && state !== 'EDITING_CONTENT') {
            if (state === 'AWAITING_ADMIN_REPLY') {
                const { targetUserId } = stateData;
                if (!targetUserId) {
                    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                    return ctx.reply('⚠️ حدث خطأ: لم يتم العثور على المستخدم المراد الرد عليه.');
                }
                try {
                    // 1. جلب كل المشرفين بترتيب ثابت لتحديد رقم المشرف
                    const adminsResult = await client.query("SELECT id FROM public.users WHERE is_admin = true ORDER BY id");
                    const adminIds = adminsResult.rows.map(row => String(row.id));
                    
                    // 2. تحديد رقم المشرف الحالي (index + 1)
                    const adminIndex = adminIds.indexOf(String(ctx.from.id));
                    const adminNumber = adminIndex !== -1 ? adminIndex + 1 : 'غير محدد';

                    // 3. إرسال الرد الفعلي للمستخدم
                    await ctx.copyMessage(targetUserId);

                    // 4. إنشاء زر رد ورسالة للمستخدم تحمل رقم المشرف
                    const replyMarkup = { 
                        inline_keyboard: [[ Markup.button.callback(`✍️ الرد على الأدمن رقم ${adminNumber}`, `user:reply:${ctx.from.id}`) ]] 
                    };
                    await bot.telegram.sendMessage(targetUserId, `✉️ رسالة جديدة من الأدمن رقم *${adminNumber}*`, { parse_mode: 'Markdown', reply_markup: replyMarkup });

                    await ctx.reply('✅ تم إرسال ردك بنجاح.');
                } catch (e) {
                    console.error(`Failed to send admin reply to user ${targetUserId}:`, e.message);
                    await ctx.reply(`❌ فشل إرسال الرسالة للمستخدم ${targetUserId}. قد يكون المستخدم قد حظر البوت.`);
                } finally {
                    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                }
                return;
            }

           if (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_REPLACEMENT_FILE' || state === 'AWAITING_EDITED_TEXT' || state === 'AWAITING_NEW_CAPTION') {
                const { buttonId, messageId, targetOrder } = stateData;
                if (!buttonId) {
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ حدث خطأ: لم يتم العثور على الزر. تم إلغاء العملية.");
                }

                if (state === 'AWAITING_EDITED_TEXT') {
                    // ... (This part is correct, no changes needed)
                    if (!messageId) {
                        await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    let type, content, caption = '', entities = [];
                    if (ctx.message.text) { type = "text"; content = ctx.message.text; entities = ctx.message.entities || []; } 
                    else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; } 
                    else if (ctx.message.video) { type = "video"; content = ctx.message.video.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; } 
                    else if (ctx.message.document) { type = "document"; content = ctx.message.document.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; } 
                    else if (ctx.message.audio) { type = "audio"; content = ctx.message.audio.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; } 
                    else if (ctx.message.voice) { type = "voice"; content = ctx.message.voice.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; } 
                    else { return ctx.reply('⚠️ نوع الرسالة غير مدعوم.'); }
                    const query = 'UPDATE public.messages SET type = $1, content = $2, caption = $3, entities = $4 WHERE id = $5';
                    const values = [type, content, caption, JSON.stringify(entities), messageId];
                    await client.query(query, values);
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث الرسالة بنجاح.');
                    return;
                }
                
                if (state === 'AWAITING_NEW_CAPTION') {
                    // ... (This part is correct, no changes needed)
                     if (!messageId) {
                          await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    const newCaption = ctx.message.text || ctx.message.caption;
                    if (typeof newCaption !== 'string') {
                        return ctx.reply('⚠️ يرجى إرسال نص أو رسالة تحتوي على شرح.');
                    }
                    const newEntities = ctx.message.entities || ctx.message.caption_entities || [];
                    const query = 'UPDATE public.messages SET caption = $1, entities = $2 WHERE id = $3';
                    const values = [newCaption, JSON.stringify(newEntities), messageId];
                    await client.query(query, values);
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث الشرح بنجاح.');
                    return;
                }

                // --- THE FIX IS IN THE LOGIC BELOW ---

                let type, content, caption = ctx.message.caption || '', entities = ctx.message.caption_entities || [];
                if (ctx.message.text) { type = "text"; content = ctx.message.text; caption = ""; entities = ctx.message.entities || []; }
                else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; }
                else if (ctx.message.video) { type = "video"; content = ctx.message.video.file_id; }
                else if (ctx.message.document) { type = "document"; content = ctx.message.document.file_id; }
                else if (ctx.message.audio) { type = "audio"; content = ctx.message.audio.file_id; }
                else if (ctx.message.voice) { type = "voice"; content = ctx.message.voice.file_id; }
                else { 
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ نوع الرسالة غير مدعوم. تم إلغاء العملية.");
                }
                
                if (state === 'AWAITING_REPLACEMENT_FILE') {
                    if (!messageId) {
                        await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    const query = 'UPDATE public.messages SET type = $1, content = $2, caption = $3, entities = $4 WHERE id = $5';
                    const values = [type, content, caption, JSON.stringify(entities), messageId];
                    await client.query(query, values);
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم استبدال الملف بنجاح.');
                } else { // This block handles AWAITING_NEW_MESSAGE
                    try {
                        await client.query('BEGIN'); // Start transaction

                        // Step 1: Make space for the new message with guaranteed sequential updates.
                        if (targetOrder !== undefined) {
                            // First, get all messages that need to be shifted, in reverse order.
                            const messagesToShiftResult = await client.query(
                                'SELECT id FROM public.messages WHERE button_id = $1 AND "order" >= $2 ORDER BY "order" DESC',
                                [buttonId, targetOrder]
                            );

                            // Next, loop through them and update one by one. This prevents collisions.
                            for (const msg of messagesToShiftResult.rows) {
                                await client.query(
                                    'UPDATE public.messages SET "order" = "order" + 1 WHERE id = $1',
                                    [msg.id]
                                );
                            }
                        }
                        
                        // If no targetOrder is specified, calculate the new order to be at the end.
                        const finalOrder = targetOrder !== undefined
                            ? targetOrder
                            : (await client.query('SELECT COALESCE(MAX("order"), -1) + 1 AS next_order FROM public.messages WHERE button_id = $1', [buttonId])).rows[0].next_order;

                        // Step 2: Now, safely insert the new message into the correct slot.
                        const query = 'INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)';
                        const values = [buttonId, finalOrder, type, content, caption, JSON.stringify(entities)];
                        await client.query(query, values);
                        
                        await client.query('COMMIT'); // Commit the successful transaction
                    } catch (e) {
                        await client.query('ROLLBACK'); // Rollback the transaction on error
                        console.error("Error adding new message:", e);
                        await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("❌ حدث خطأ أثناء إضافة الرسالة. تم إلغاء العملية.");
                    }
                    
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم إضافة الرسالة بنجاح.');
                }
                return;
            }

           // الكود الجديد والمصحح
if (state === 'AWAITING_BROADCAST') {
    const allUsersResult = await client.query('SELECT id FROM public.users WHERE banned = false');
    const allUsers = allUsersResult.rows;
    let successCount = 0;
    let failureCount = 0;
    const statusMessage = await ctx.reply(`⏳ جاري إرسال الرسالة إلى ${allUsers.length} مستخدم...`);

    // التحقق إذا كانت الرسالة استطلاعًا
    const isPoll = !!ctx.message.poll;

    for (const user of allUsers) {
        try {
            if (isPoll) {
                // استخدم forwardMessage للاستطلاعات للحفاظ على التفاعلية
                await bot.telegram.forwardMessage(user.id, ctx.chat.id, ctx.message.message_id);
            } else {
                // استخدم copyMessage لباقي أنواع الرسائل لإخفاء هوية المرسل
                await ctx.copyMessage(user.id);
            }
            successCount++;
        } catch (e) {
            failureCount++;
            console.error(`Failed to broadcast to user ${user.id}:`, e.message);
        }
    }

    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ تم الإرسال بنجاح إلى ${successCount} مستخدم.\n❌ فشل الإرسال إلى ${failureCount} مستخدم.`);
    await updateUserState(userId, { state: 'NORMAL' });
    return;
}

            if (state === 'AWAITING_WELCOME_MESSAGE') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال رسالة نصية فقط.');
                await client.query('INSERT INTO public.settings (id, welcome_message) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET welcome_message = EXCLUDED.welcome_message', [ctx.message.text]);
                await ctx.reply('✅ تم تحديث رسالة الترحيب بنجاح.');
                await updateUserState(userId, { state: 'NORMAL' });
                return;
            }
            if (state === 'AWAITING_NEW_BUTTON_NAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال نص يحتوي على أسماء الأزرار.');

              const reservedNames = [
    // --- أزرار أساسية ---
    '🔝 القائمة الرئيسية', '🔙 رجوع', '👑 الإشراف', '💬 التواصل مع الأدمن',
    // --- أزرار تعديل المحتوى ---
    '📄 تعديل المحتوى', '🚫 إلغاء تعديل المحتوى', '➕ إضافة رسالة',
    // --- أزرار تعديل الأزرار ---
    '✏️ تعديل الأزرار', '🚫 إلغاء تعديل الأزرار', '➕ إضافة زر',
    // --- أزرار الإشراف ---
    '📊 الإحصائيات', '🗣️ رسالة جماعية', '🔔 رسالة التنبيه', '⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب', '🚫 قائمة المحظورين',
    // --- أزرار النسخ والنقل والبيانات (الجديدة) ---
    '✂️ نقل أزرار',
    '📥 نسخ أزرار',
    '📥 نقل البيانات',
    '➕ أزرار افتراضية', // 🟢 تم إضافة هذا الزر
    '✅ تأكيد الاختيار', // لمنع إنشاء زر بنفس النص بدون العدد
    '✅ النقل إلى هنا',
    '✅ النسخ إلى هنا',
    '❌ إلغاء',
    '❌ إلغاء النقل',
    '❌ إلغاء العملية',
    '✅ إنهاء وإضافة الكل'
];
// ... باقي الكود
           

                const buttonNames = ctx.message.text.split('\n').map(name => name.trim()).filter(name => name.length > 0);
                if (buttonNames.length === 0) {
                    return ctx.reply('⚠️ لم يتم العثور على أسماء أزرار صالحة.');
                }
                
                const parentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                const lastOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL'), parentId ? [parentId] : []);
                let lastOrder = lastOrderResult.rows[0].max_order;
                
                let addedCount = 0;
                let skippedMessages = [];

                for (const newButtonName of buttonNames) {
                    if (reservedNames.includes(newButtonName)) {
                        skippedMessages.push(`- "${newButtonName}" (اسم محجوز)`);
                        continue;
                    }
                    
                    let queryText, queryValues;
                    if (parentId) {
                        queryText = 'SELECT id FROM public.buttons WHERE parent_id = $1 AND text = $2';
                        queryValues = [parentId, newButtonName];
                    } else {
                        queryText = 'SELECT id FROM public.buttons WHERE parent_id IS NULL AND text = $1';
                        queryValues = [newButtonName];
                    }
                    const existingButtonResult = await client.query(queryText, queryValues);

                    if (existingButtonResult.rows.length > 0) {
                        skippedMessages.push(`- "${newButtonName}" (موجود بالفعل)`);
                        continue;
                    }

                    lastOrder++;
                    addedCount++;
                    
                    const query = 'INSERT INTO public.buttons (text, parent_id, "order", is_full_width, admin_only) VALUES ($1, $2, $3, $4, $5)';
                    const values = [newButtonName, parentId, lastOrder, true, false];
                    await client.query(query, values);
                }

                let summaryMessage = `✅ تمت إضافة ${addedCount} زر بنجاح.`;
                if (skippedMessages.length > 0) {
                    summaryMessage += `\n\n⚠️ تم تخطي الأزرار التالية:\n${skippedMessages.join('\n')}`;
                }

                await updateUserState(userId, { state: 'EDITING_BUTTONS' });
                await ctx.reply(summaryMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }

            if (state === 'AWAITING_RENAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال اسم نصي فقط.');
                const newButtonName = ctx.message.text;
                const buttonIdToRename = stateData.buttonId;
                if (!buttonIdToRename) {
                     await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                     return ctx.reply('حدث خطأ، لم يتم العثور على الزر المراد تعديله.');
                }
                const buttonResult = await client.query('SELECT parent_id FROM public.buttons WHERE id = $1', [buttonIdToRename]);
                const parentId = buttonResult.rows[0]?.parent_id;
                
                let queryText, queryValues;
                if (parentId) {
                    queryText = 'SELECT id FROM public.buttons WHERE parent_id = $1 AND text = $2 AND id <> $3';
                    queryValues = [parentId, newButtonName, buttonIdToRename];
                } else {
                    queryText = 'SELECT id FROM public.buttons WHERE parent_id IS NULL AND text = $1 AND id <> $2';
                    queryValues = [newButtonName, buttonIdToRename];
                }
                const existingButtonResult = await client.query(queryText, queryValues);

                if (existingButtonResult.rows.length > 0) {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply(`⚠️ يوجد زر آخر بهذا الاسم "${newButtonName}". تم إلغاء التعديل.`);
                }
                await client.query('UPDATE public.buttons SET text = $1 WHERE id = $2', [newButtonName, buttonIdToRename]);

                await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                await ctx.reply(`✅ تم تعديل اسم الزر إلى "${newButtonName}".`, Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }
            if (state === 'AWAITING_ADMIN_ID_TO_ADD' || state === 'AWAITING_ADMIN_ID_TO_REMOVE') {
                if (!ctx.message.text || !/^\d+$/.test(ctx.message.text)) return ctx.reply("⚠️ يرجى إرسال ID رقمي صحيح.");
                const targetAdminId = ctx.message.text;
                try {
                    const userChat = await bot.telegram.getChat(targetAdminId);
                    const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                    const confirmationState = state === 'AWAITING_ADMIN_ID_TO_ADD' ? 'AWAITING_ADD_ADMIN_CONFIRMATION' : 'AWAITING_REMOVE_ADMIN_CONFIRMATION';
                    const actionText = state === 'AWAITING_ADMIN_ID_TO_ADD' ? 'إضافة' : 'حذف';
                    await updateUserState(userId, { state: confirmationState, stateData: { targetAdminId, targetAdminName: userName } });
                    return ctx.reply(`👤 المستخدم: ${userName} (<code>${targetAdminId}</code>)\nهل أنت متأكد من ${actionText} هذا المستخدم كمشرف؟\nأرسل "نعم" للتأكيد.`, { parse_mode: 'HTML'});
                } catch (e) {
                    await updateUserState(userId, { state: 'NORMAL' });
                    return ctx.reply("⚠️ لم يتم العثور على مستخدم بهذا الـ ID.");
                }
            }
            if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION' || state === 'AWAITING_REMOVE_ADMIN_CONFIRMATION') {
                if (ctx.message.text === 'نعم') {
                    const { targetAdminId, targetAdminName } = stateData;
                    if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION') {
                        await client.query('UPDATE public.users SET is_admin = true WHERE id = $1', [targetAdminId]);
                        await ctx.reply(`✅ تم إضافة ${targetAdminName} كمشرف بنجاح.`);
                    } else { // AWAITING_REMOVE_ADMIN_CONFIRMATION
                        if (targetAdminId === process.env.SUPER_ADMIN_ID) {
                           await ctx.reply('🚫 لا يمكن حذف الأدمن الرئيسي.');
                        } else {
                           await client.query('UPDATE public.users SET is_admin = false WHERE id = $1', [targetAdminId]);
                           await ctx.reply(`🗑️ تم حذف ${targetAdminName} من قائمة المشرفين.`);
                        }
                    }
                } else {
                    await ctx.reply("تم إلغاء العملية.");
                }
                await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                return;
            }
        }
        
        // هذا المقطع للرسالة الأولى فقط (يرسلها للجميع)
        if (state === 'AWAITING_BATCH_NUMBER') {
    if (ctx.message && ctx.message.text === '❌ إلغاء العملية') {
        await updateUserState(userId, { state: 'NORMAL', stateData: {} });
        return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
    }

    if (!ctx.message || !ctx.message.text) {
        return ctx.reply('⚠️ يرجى إدخال رد نصي.');
    }

    const batchText = ctx.message.text;
    // تحويل الأرقام العربية إلى الإنجليزية للتحقق
    const englishBatchText = batchText.replace(/[\u0660-\u0669]/g, c => c.charCodeAt(0) - 0x0660);

    if (!/^\d+$/.test(englishBatchText)) {
        return ctx.reply('⚠️ يرجى إدخال أرقام فقط. ما هو رقم دفعتك؟');
    }
    
    // حفظ رقم الدفعة والانتقال للخطوة التالية
    await updateUserState(userId, { 
        state: 'CONTACTING_ADMIN', 
        stateData: { batchNumber: englishBatchText } 
    });
    
    return ctx.reply(
        '✅ تم حفظ رقم الدفعة. أرسل الآن رسالتك ليتم توصيلها إلى الإدارة.',
        Markup.keyboard(await generateKeyboard(userId)).resize()
    );
}
      if (isAdmin && state === 'AWAITING_DELETE_CONFIRMATION') {
            const { buttonId, buttonName } = stateData;

            if (ctx.message && ctx.message.text === 'نعم') {
                // User confirmed deletion
                const statusMessage = await ctx.reply(`⏳ جاري الحذف العميق للقسم "${buttonName}"...`);
                
                try {
                    await client.query('BEGIN');
                    await deepDeleteButton(buttonId, client);
                    await client.query('COMMIT');

                    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `🗑️ تم الحذف العميق للقسم "${buttonName}" بنجاح.`);
                    
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');

                } catch (error) {
                    await client.query('ROLLBACK');
                    console.error("Deep-delete button error:", error);
                    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '❌ حدث خطأ فادح أثناء عملية الحذف.');
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                }

            } else {
                // User sent something else, so cancel the operation
                await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                await ctx.reply('👍 تم إلغاء عملية الحذف.', Markup.keyboard(await generateKeyboard(userId)).resize());
            }
            return;
        }

// الخطوة 3: استقبال الرسالة وإرسالها للأدمن
if (state === 'CONTACTING_ADMIN') {
    if (ctx.message && ctx.message.text === '❌ إلغاء العملية') {
        await updateUserState(userId, { state: 'NORMAL', stateData: {} });
        return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
    }
    
    const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
    const adminIds = adminsResult.rows.map(row => String(row.id));
    if (adminIds.length > 0) {
        const from = ctx.from;
        // جلب رقم الدفعة من البيانات المحفوظة
        const batchNumber = stateData.batchNumber || 'غير محدد';
        // تحديث الرسالة التعريفية لتشمل رقم الدفعة
        const userDetails = `👤 <b>رسالة جديدة من مستخدم!</b>\n\n` +
                          `<b>الدفعة:</b> <code>${batchNumber}</code>\n` +
                          `<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}\n` +
                          `<b>المعرف:</b> @${from.username || 'لا يوجد'}\n` +
                          `<b>ID:</b> <code>${from.id}</code>`;

        for (const adminId of adminIds) {
            try {
                const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ رد', `admin:reply:${from.id}`), Markup.button.callback('🚫 حظر', `admin:ban:${from.id}`) ]] };
                await bot.telegram.sendMessage(adminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                await ctx.copyMessage(adminId);
            } catch (e) { console.error(`Failed to send message to admin ${adminId}:`, e); }
        }
    }
    
    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
    
    // إصلاح المشكلة: تحديث لوحة المفاتيح بعد الإرسال
    await ctx.reply(
        '✅ تم إرسال رسالتك إلى الأدمن بنجاح.',
        Markup.keyboard(await generateKeyboard(userId)).resize()
    );
    return;
}

        // هذا المقطع الجديد لرد المستخدم على أدمن محدد
        if (state === 'REPLYING_TO_ADMIN') {
            const { targetAdminId } = stateData;
            if (!targetAdminId) {
                await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                return ctx.reply('⚠️ حدث خطأ، لم يتم تحديد المشرف للرد عليه.');
            }
            const from = ctx.from;
            const userDetails = `📝 <b>رد من مستخدم!</b>\n\n<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}` + `\n<b>المعرف:</b> @${from.username || 'لا يوجد'}` + `\n<b>ID:</b> <code>${from.id}</code>`;
            
            try {
                // إرسال الرد للأدمن المحدد فقط
                const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ رد', `admin:reply:${from.id}`), Markup.button.callback('🚫 حظر', `admin:ban:${from.id}`) ]] };
                await bot.telegram.sendMessage(targetAdminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                await ctx.copyMessage(targetAdminId);
            } catch (e) {
                 console.error(`Failed to send reply to admin ${targetAdminId}:`, e);
            }

            await updateUserState(userId, { state: 'NORMAL', stateData: {} });
            await ctx.reply('✅ تم إرسال ردك للمشرف بنجاح.');
            return;
        }

        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;

        switch (text) {
           case '🔝 القائمة الرئيسية':
    // هذا التعديل يقوم فقط بتغيير المسار دون مسح بيانات النقل
    await updateUserState(userId, { currentPath: 'root' }); 
    return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
           case '🔙 رجوع':
    const newPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
    // هذا التعديل يقوم فقط بالرجوع للخلف دون مسح بيانات النقل
    await updateUserState(userId, { currentPath: newPath });
    return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '💬 التواصل مع الأدمن':
        await updateUserState(userId, { state: 'AWAITING_BATCH_NUMBER', stateData: {} });
        await ctx.reply(
            'أدخل رقم الدفعة الخاص بك',
            Markup.keyboard(await generateKeyboard(userId)).resize()
        );
        return;
            case '👑 الإشراف':
                if (isAdmin && currentPath === 'root') {
                    await updateUserState(userId, { currentPath: 'supervision', stateData: {} });
                    return ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '🔔 رسالة التنبيه':
                if (isAdmin && currentPath === 'supervision') {
                    const settingsResult = await client.query('SELECT alert_message, alert_message_set_at, alert_duration_hours FROM public.settings WHERE id = 1');
                    const alert = settingsResult.rows[0];
                    let statusMessage = 'ℹ️ **حالة رسالة التنبيه**\n\n';

                    // تحقق إذا كان التنبيه فعالاً ويحتوي على مصفوفة رسائل غير فارغة
                    if (alert && Array.isArray(alert.alert_message) && alert.alert_message.length > 0 && alert.alert_message_set_at) {
                        const alertSetAt = new Date(alert.alert_message_set_at);
                        const expiresAt = new Date(alertSetAt.getTime() + alert.alert_duration_hours * 60 * 60 * 1000);
                        const countResult = await client.query('SELECT COUNT(*) FROM public.users WHERE last_alert_seen_at >= $1', [alertSetAt]);
                        const seenCount = countResult.rows[0].count;

                        statusMessage += `الحالة: **فعّالة** ✅\n`;
                        statusMessage += `عدد الرسائل: \`${alert.alert_message.length}\`\n`;
                        statusMessage += `عدد من شاهدوا التنبيه: \`${seenCount}\`\n`;
                        statusMessage += `ستنتهي في: \`${expiresAt.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}\`\n\n`;
                        
                        await ctx.replyWithMarkdown(statusMessage);
                        
                        // عرض محتوى التنبيه الحالي للأدمن
                        await ctx.reply('--- 🔽 محتوى التنبيه الحالي 🔽 ---');
                        for (const msg of alert.alert_message) {
                            switch(msg.type) {
                                case 'text': await ctx.reply(msg.content, { entities: msg.entities }); break;
                                case 'photo': await ctx.replyWithPhoto(msg.content, { caption: msg.caption, caption_entities: msg.entities }); break;
                                case 'document': await ctx.replyWithDocument(msg.content, { caption: msg.caption, caption_entities: msg.entities }); break;
                                case 'video': await ctx.replyWithVideo(msg.content, { caption: msg.caption, caption_entities: msg.entities }); break;
                            }
                        }
                    } else {
                        statusMessage += 'الحالة: **غير فعّالة** ❌';
                        await ctx.replyWithMarkdown(statusMessage);
                    }
                    
                    // عرض أزرار التحكم
                    // عرض أزرار التحكم
                    // عرض أزرار التحكم
                    await ctx.reply('اختر الإجراء المطلوب:', Markup.inlineKeyboard([
                        [Markup.button.callback('➕ تعيين تنبيه جديد', 'alert:set')],
                        [Markup.button.callback('🗑️ حذف التنبيه الحالي', 'alert:delete')],
                        [Markup.button.callback('📌 إلغاء تثبيت التنبيه للجميع', 'alert:unpin_all')] // <-- الزر الجديد
                    ]));
                }
                break;
            case '✏️ تعديل الأزرار':
            case '🚫 إلغاء تعديل الأزرار':
                if (isAdmin) {
                    const newState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
                    await updateUserState(userId, { state: newState, stateData: {} });
                    return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '📄 تعديل المحتوى':
            case '🚫 إلغاء تعديل المحتوى':
                if (isAdmin) {
                    const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                    await updateUserState(userId, { state: newContentState, stateData: {} });
                    await ctx.reply(`تم ${newContentState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل المحتوى.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    if (newContentState === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                        const buttonId = currentPath.split('/').pop();
                        await sendButtonMessages(ctx, buttonId, true);
                    }
                    return;
                }
                break;
            case '➕ إضافة زر':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, { state: 'AWAITING_NEW_BUTTON_NAME' });
                    return ctx.reply(' أدخل اسم الزر الجديد: يمكنك ادخال اكثر من اسم مفصولين ب enter اي كل اسم في سطر منفرد');
                }
                break;
            case '➕ إضافة رسالة':
                if (isAdmin && state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                    await updateUserState(userId, {
                        state: 'AWAITING_BULK_MESSAGES',
                        stateData: { buttonId: currentPath.split('/').pop(), collectedMessages: [] }
                    });
                    await ctx.reply('📝 وضع إضافة الرسائل المتعددة 📝\n\nأرسل أو وجّه الآن كل الرسائل التي تريد إضافتها. عند الانتهاء، اضغط على زر "✅ إنهاء الإضافة".',
                        Markup.keyboard(await generateKeyboard(userId)).resize()
                    );
                }
                break;
           case '✂️ نقل أزرار':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, {
                        state: 'SELECTING_BUTTONS',
                        stateData: { selectionAction: 'move', selectedButtons: [] }
                    });
                    return ctx.reply('✂️ **وضع تحديد الأزرار للنقل**\n\nاضغط على الأزرار التي تريد نقلها لتحديدها. عند الانتهاء، اضغط "✅ تأكيد الاختيار".', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            
            // **جديد**: case لتفعيل وضع النسخ
            case '📥 نسخ أزرار':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, {
                        state: 'SELECTING_BUTTONS',
                        stateData: { selectionAction: 'copy', selectedButtons: [] }
                    });
                    return ctx.reply('📥 **وضع تحديد الأزرار للنسخ**\n\nاضغط على الأزرار التي تريد نسخها لتحديدها. عند الانتهاء، اضغط "✅ تأكيد الاختيار".', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;

            // **تعديل**: case تأكيد الاختيار أصبح أذكى
            case (text.match(/^✅ تأكيد الاختيار \(\d+\)$/) || {}).input:
                if (isAdmin && state === 'SELECTING_BUTTONS') {
                    const selectedCount = stateData.selectedButtons?.length || 0;
                    if (selectedCount === 0) {
                        return ctx.reply('⚠️ لم تحدد أي أزرار.');
                    }
                    await updateUserState(userId, { state: 'AWAITING_DESTINATION' });
                    const actionName = stateData.selectionAction === 'copy' ? 'لنسخها' : 'لنقلها';
                    return ctx.reply(`🚙 تم تحديد ${selectedCount} زر.\n\nالآن، اذهب إلى القسم الذي تريد ${actionName} إليه ثم اضغط على الزر المناسب.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            // ... باقي الحالات
            case '➕ أزرار افتراضية':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, {
                        state: 'AWAITING_DEFAULT_BUTTON_NAMES',
                        stateData: {}
                    });
                    return ctx.reply(
                        '📝 **ميزة الأزرار الافتراضية**\n\n' +
                        'أرسل الآن أسماء الأزرار التي تريد إضافتها بشكل متكرر. اجعل كل اسم في سطر منفصل.\n\n' +
                        'عند الانتهاء، اضغط على "✅ تأكيد الأسماء والانتقال للاختيار".',
                        { parse_mode: 'Markdown' }
                    );
                }
                break;
// ...
            case '📥 نقل البيانات':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, { 
                        state: 'DYNAMIC_TRANSFER', 
                        stateData: { 
                            step: 'AWAITING_BUTTON_SOURCE',
                            completedUnits: [] // لتخزين الوحدات المكتملة (زر + محتواه)
                        }
                    });
                    return ctx.reply('📥 **وضع النقل الديناميكي**\n\n**الخطوة 1:** قم بإعادة توجيه أي رسالة من (القناة أو الجروب أو البوت) الذي يمثل **مصدر الأزرار**.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '❌ إلغاء العملية':
                if (isAdmin && state === 'DYNAMIC_TRANSFER') {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '✅ النقل إلى هنا':
                if (isAdmin && state === 'AWAITING_DESTINATION' && stateData.selectionAction === 'move') {
                    const { selectedButtons } = stateData;
                    if (!selectedButtons || selectedButtons.length === 0) {
                        return ctx.reply('❌ خطأ: لا توجد أزرار محددة للنقل. تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                    const newParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                    try {
                        await client.query('BEGIN');
                        for (const button of selectedButtons) {
                            // التحقق من عدم نقل القسم إلى نفسه أو إلى أحد فروعه (منع التكرار اللانهائي)
                            if (button.id === newParentId) {
                                await ctx.reply(`⚠️ تم تخطي نقل الزر "${button.text}" لأنه لا يمكن نقل قسم إلى داخل نفسه.`);
                                continue;
                            }
                            await client.query('UPDATE public.buttons SET parent_id = $1 WHERE id = $2', [newParentId, button.id]);
                        }
                        await client.query('COMMIT');
                        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                        await ctx.reply(`✅ تم نقل ${selectedButtons.length} أزرار بنجاح.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    } catch (error) {
                        await client.query('ROLLBACK');
                        console.error("Multi-move button error:", error);
                        return ctx.reply(`❌ حدث خطأ أثناء نقل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                }
                break;

            // **جديد**: case لتنفيذ عملية النسخ
            case '✅ النسخ إلى هنا':
                if (isAdmin && state === 'AWAITING_DESTINATION' && stateData.selectionAction === 'copy') {
                    const { selectedButtons } = stateData;
                    if (!selectedButtons || selectedButtons.length === 0) {
                         return ctx.reply('❌ خطأ: لا توجد أزرار محددة للنسخ. تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                    const newParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                    const statusMessage = await ctx.reply(`⏳ جاري النسخ العميق لـ ${selectedButtons.length} قسم... هذه العملية قد تستغرق بعض الوقت.`);

                    try {
                        await client.query('BEGIN'); // بدء transaction لضمان تنفيذ كل شيء أو لا شيء

                        for (const originalButton of selectedButtons) {
                             if (originalButton.id === newParentId) {
                                await ctx.reply(`⚠️ تم تخطي نسخ الزر "${originalButton.text}" لأنه لا يمكن نسخ قسم إلى داخل نفسه.`);
                                continue;
                            }
                            // **التعديل الرئيسي**: استدعاء دالة النسخ العميق
                            await deepCopyButton(originalButton.id, newParentId, client);
                        }

                        await client.query('COMMIT'); // تأكيد كل التغييرات
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ تم النسخ العميق لـ ${selectedButtons.length} قسم بنجاح.`);
                        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                        await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');

                    } catch (error) {
                        await client.query('ROLLBACK'); // تراجع عن كل التغييرات في حالة حدوث خطأ
                        console.error("Deep-copy button error:", error);
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '❌ حدث خطأ فادح أثناء عملية النسخ العميق.');
                        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                        return refreshKeyboardView(ctx, userId, 'تم إلغاء العملية.');
                    }
                }
                break;

            // **تعديل**: زر الإلغاء العام
            case '❌ إلغاء':
                if (isAdmin && (state === 'AWAITING_DESTINATION' || state === 'SELECTING_BUTTONS')) {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
        }

      // --- معالجة أزرار قائمة الإشراف ---
        if (currentPath === 'supervision' && isAdmin) {
            let supervisionCommandHandled = true;
            switch (text) {
                case '📊 الإحصائيات': {
    const [ generalStatsData, topDaily, topAllTime ] = await Promise.all([
        (async () => {
            const client = await getClient();
            try {
                const dailyActiveUsersResult = await client.query("SELECT COUNT(DISTINCT user_id) FROM public.button_clicks_log WHERE (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date");
                const active3dResult = await client.query("SELECT COUNT(DISTINCT id) FROM public.users WHERE last_active > NOW() AT TIME ZONE 'Africa/Cairo' - INTERVAL '3 DAY'");
                const active7dResult = await client.query("SELECT COUNT(DISTINCT id) FROM public.users WHERE last_active > NOW() AT TIME ZONE 'Africa/Cairo' - INTERVAL '7 DAY'");
                const inactive3dResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active < NOW() AT TIME ZONE 'Africa/Cairo' - INTERVAL '3 DAY'");
                const inactive7dResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active < NOW() AT TIME ZONE 'Africa/Cairo' - INTERVAL '7 DAY'");
                const totalButtonsResult = await client.query('SELECT COUNT(*) FROM public.buttons');
                const totalMessagesResult = await client.query('SELECT COUNT(*) FROM public.messages');
                const totalUsersResult = await client.query('SELECT COUNT(*) FROM public.users');
                const dailyTotalClicksResult = await client.query("SELECT COUNT(*) FROM public.button_clicks_log WHERE (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date");
                const totalAllTimeClicksResult = await client.query('SELECT (SELECT COUNT(*) FROM public.button_clicks_log) + COALESCE((SELECT SUM(total_clicks) FROM public.lifetime_button_stats), 0) AS total_clicks');
                
                return {
                    dailyActiveUsers: dailyActiveUsersResult.rows[0].count || 0,
                    active3d: active3dResult.rows[0].count,
                    active7d: active7dResult.rows[0].count,
                    inactive3d: inactive3dResult.rows[0].count,
                    inactive7d: inactive7dResult.rows[0].count,
                    totalButtons: totalButtonsResult.rows[0].count,
                    totalMessages: totalMessagesResult.rows[0].count,
                    totalUsers: totalUsersResult.rows[0].count,
                    dailyTotalClicks: dailyTotalClicksResult.rows[0].count || 0,
                    totalAllTimeClicks: totalAllTimeClicksResult.rows[0].total_clicks || 0
                };
            } finally { client.release(); }
        })(),
        processAndFormatTopButtons('daily'),
        processAndFormatTopButtons('all_time')
    ]);
    
    const { dailyActiveUsers, active3d, active7d, inactive3d, inactive7d, totalButtons, totalMessages, totalUsers, dailyTotalClicks, totalAllTimeClicks } = generalStatsData;

    // ✨ التعديل هنا: تم تهريب جميع علامات الشرطة والأقواس
    const generalStats = `*📊 الإحصائيات العامة:*\n\n` +
                         `👥 إجمالي المستخدمين: \`${totalUsers}\`\n\n` +
                         `*👤 المستخدمون النشطون:*\n` +
                         `\\- اليوم \\(تفاعلوا\\): \`${dailyActiveUsers}\`\n` +
                         `\\- آخر 3 أيام: \`${active3d}\`\n` +
                         `\\- آخر 7 أيام: \`${active7d}\`\n\n` +
                         `*🚫 المستخدمون غير النشطين:*\n` +
                         `\\- أكثر من 3 أيام: \`${inactive3d}\`\n` +
                         `\\- أكثر من 7 أيام: \`${inactive7d}\`\n\n` +
                         `*🗂 محتوى البوت:*\n` +
                         `\\- الأزرار: \`${totalButtons}\`\n` +
                         `\\- الرسائل: \`${totalMessages}\`\n\n` +
                         `*🖱️ الضغطات:*\n` +
                         `\\- اليوم: \`${dailyTotalClicks}\`\n` +
                         `\\- الكلية: \`${totalAllTimeClicks}\``;

    const finalReport = `${generalStats}\n\n*\\-\\-\\-\\-*\n\n${topDaily}\n\n*\\-\\-\\-\\-*\n\n${topAllTime}`;
    await ctx.reply(finalReport, { parse_mode: 'MarkdownV2' });
    break;
}
                case '🗣️ رسالة جماعية':
                    await updateUserState(userId, { 
                        state: 'AWAITING_BROADCAST_MESSAGES', 
                        stateData: { collectedMessages: [] }
                    });
                    await ctx.reply(
                        '📝 **وضع البث الجماعي** 📝\n\n' +
                        'أرسل أو وجّه الآن **كل** الرسائل التي تريد بثها للمستخدمين (نص، صورة، فيديو، ملف...).' +
                        '\n\nعندما تنتهي، اضغط على زر "✅ إنهاء الإضافة والبدء".',
                        {
                            parse_mode: 'Markdown',
                            ...Markup.keyboard(await generateKeyboard(userId)).resize()
                        }
                    );
                    break;
                case '⚙️ تعديل المشرفين':
                     if (userId !== process.env.SUPER_ADMIN_ID) { 
                         await ctx.reply('🚫 هذه الميزة للمشرف الرئيسي فقط.'); 
                         break;
                     }
                    const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
                    let adminListText = '<b>المشرفون الحاليون:</b>\n';
                    for (const row of adminsResult.rows) {
                        const adminId = String(row.id);
                        try {
                            const userChat = await bot.telegram.getChat(adminId);
                            const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                            adminListText += `- ${userName} (<code>${adminId}</code>)\n`;
                        } catch (e) { adminListText += `- <code>${adminId}</code> (لم يتم العثور على المستخدم)\n`; }
                    }
                    await ctx.replyWithHTML(adminListText, Markup.inlineKeyboard([
                        [Markup.button.callback('➕ إضافة مشرف', 'admin:add'), Markup.button.callback('➖ حذف مشرف', 'admin:remove')]
                    ]));
                    break;
                case '📝 تعديل رسالة الترحيب':
                    await updateUserState(userId, { state: 'AWAITING_WELCOME_MESSAGE' });
                    await ctx.reply('أرسل رسالة الترحيب الجديدة:');
                    break;
                case '🚫 قائمة المحظورين': {
                    const bannedUsersResult = await client.query('SELECT id FROM public.users WHERE banned = true');
                    if (bannedUsersResult.rows.length === 0) {
                        await ctx.reply('✅ لا يوجد مستخدمون محظورون حاليًا.');
                        break;
                    }
                    let bannedListMessage = '<b>🚫 قائمة المستخدمين المحظورين:</b>\n\n';
                    for (const row of bannedUsersResult.rows) {
                        const bannedUserId = String(row.id);
                        let userName = 'مستخدم غير معروف', userUsername = 'لا يوجد';
                        try {
                            const userChat = await bot.telegram.getChat(bannedUserId);
                            userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                            if (userChat.username) userUsername = `@${userChat.username}`;
                        } catch (e) { console.error(`Could not fetch info for banned user ${bannedUserId}`); }
                        
                        bannedListMessage += `👤 <b>الاسم:</b> ${userName}\n` +
                                             `<b>المعرف:</b> ${userUsername}\n` +
                                             `🆔 <b>ID:</b> <code>${bannedUserId}</code>\n` +
                                             `CMD: <code>/unban ${bannedUserId}</code>\n---\n`;
                    }
                    await ctx.replyWithHTML(bannedListMessage);
                    break;
                }
                default:
                    supervisionCommandHandled = false;
            }
            return;
        }
        
        // --- إذا لم يكن أي مما سبق، ابحث عن زر عادي في قاعدة البيانات ---
        const currentParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
        
        let buttonResult;
        if (currentParentId === null) {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id IS NULL AND text = $1', [text]);
        } else {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id = $1 AND text = $2', [currentParentId, text]);
        }
        
        const buttonInfo = buttonResult.rows[0];
        if (!buttonInfo) return; // لم يتم العثور على زر مطابق
        const buttonId = buttonInfo.id;

        if (isAdmin && state === 'AWAITING_SOURCE_BUTTON_TO_MOVE') {
            await updateUserState(userId, { state: 'AWAITING_DESTINATION_PATH', stateData: { sourceButtonId: buttonId, sourceButtonText: text } });
            return ctx.reply(`✅ تم اختيار [${text}].\n\n🚙 الآن، تنقّل بحرية داخل البوت وعندما تصل للمكان المطلوب اضغط على زر "✅ النقل إلى هنا".`, Markup.keyboard(await generateKeyboard(userId)).resize());
        }

        if (buttonInfo.admin_only && !isAdmin) {
            return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            if (stateData && stateData.lastClickedButtonId === buttonId) {
                await updateUserState(userId, { currentPath: `${currentPath}/${buttonId}`, stateData: {} });
                await ctx.reply(`تم الدخول إلى "${text}"`, Markup.keyboard(await generateKeyboard(userId)).resize());
            } else {
                await updateUserState(userId, { stateData: { lastClickedButtonId: buttonId } });
                
                const buttonStatus = buttonInfo.admin_only ? '🔒 للمشرفين فقط' : '👥 للجميع';
                const messageText = `تم اختيار الزر: *${text}*\n` +
                                  `الحالة الحالية: *${buttonStatus}*\n\n` +
                                  `(اضغط مرة أخرى للدخول إليه وتعديل محتواه)`;

                // ✨ تم إرجاع تصميم الأزرار إلى صف واحد هنا ✨
                const inlineKb = [[ 
                    Markup.button.callback('✏️', `btn:rename:${buttonId}`), 
                    Markup.button.callback('🗑️', `btn:delete:${buttonId}`), 
                    Markup.button.callback('📊', `btn:stats:${buttonId}`), 
                    Markup.button.callback('🔒', `btn:adminonly:${buttonId}`), 
                    Markup.button.callback('◀️', `btn:left:${buttonId}`), 
                    Markup.button.callback('🔼', `btn:up:${buttonId}`), 
                    Markup.button.callback('🔽', `btn:down:${buttonId}`), 
                    Markup.button.callback('▶️', `btn:right:${buttonId}`) 
                ]];
                
                await ctx.replyWithMarkdown(messageText, Markup.inlineKeyboard(inlineKb));
            }
            return;
        }
        
        const hasSubButtonsResult = await client.query('SELECT EXISTS(SELECT 1 FROM public.buttons WHERE parent_id = $1)', [buttonId]);
        const hasMessagesResult = await client.query('SELECT EXISTS(SELECT 1 FROM public.messages WHERE button_id = $1)', [buttonId]);
        const hasSubButtons = hasSubButtonsResult.rows[0].exists;
        const hasMessages = hasMessagesResult.rows[0].exists;

        await updateButtonStats(buttonId, userId);

        const canEnter = hasSubButtons || (isAdmin && ['EDITING_CONTENT', 'EDITING_BUTTONS', 'AWAITING_DESTINATION'].includes(state));
        
        if (canEnter) {
            await updateUserState(userId, { currentPath: `${currentPath}/${buttonId}` });
            await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
           let replyText = `أنت الآن في قسم: ${text}`;
            if (state === 'AWAITING_DESTINATION' && !hasSubButtons && !hasMessages) {
                const actionText = stateData.selectionAction === 'copy' ? 'النسخ' : 'النقل';
                replyText = `🧭 تم الدخول إلى القسم الفارغ [${text}].\nاضغط "✅ ${actionText} إلى هنا" لاختياره كوجهة.`;
            } else if ((state === 'EDITING_CONTENT' || state === 'EDITING_BUTTONS') && !hasMessages && !hasSubButtons) {
                replyText = 'هذا الزر فارغ. يمكنك الآن إضافة رسائل أو أزرار فرعية.';
            }
            await ctx.reply(replyText, Markup.keyboard(await generateKeyboard(userId)).resize());
        } else if (hasMessages) {
            await sendButtonMessages(ctx, buttonId, false);
        } else {
            await ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
        }
        
 } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        console.error("Caused by update:", JSON.stringify(ctx.update, null, 2));
        if (ctx) {
            await ctx.reply("حدث خطأ فادح. تم إبلاغ المطور.").catch(e => console.error("Failed to send error message to user:", e));
        }
    } finally { 
        if (client) {
            client.release(); 
        }
    }
};

bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const data = ctx.callbackQuery.data;
        
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return ctx.answerCbQuery('المستخدم غير موجود.');
        const userDoc = userResult.rows[0];

        const parts = data.split(':');
        const action = parts[0];

        if (action === 'alert') {
            const subAction = parts[1];
            if (!userDoc.is_admin) return ctx.answerCbQuery('غير مصرح لك.', { show_alert: true });
            
            if (subAction === 'set') {
                await updateUserState(userId, { state: 'AWAITING_ALERT_MESSAGES', stateData: { collectedMessages: [] } });
                await ctx.answerCbQuery();
                await ctx.editMessageText('📝 أرسل الآن أو وجّه الرسائل التي تريد استخدامها كتنبيه. عند الانتهاء، اضغط على زر "✅ إنهاء إضافة رسائل التنبيه".');
                await refreshKeyboardView(ctx, userId, 'تم تفعيل وضع إضافة رسائل التنبيه.');
                return;
            }
            if (subAction === 'delete') {
                await client.query('UPDATE public.settings SET alert_message = NULL, alert_message_set_at = NULL, alert_duration_hours = NULL WHERE id = 1');
                await ctx.editMessageText('✅ تم حذف التنبيه. الآن ستبدأ عملية إلغاء التثبيت في الخلفية.');
                await startUnpinAllJob(ctx, client); // <-- استدعاء الدالة الجديدة
                return;
            }
            if (subAction === 'unpin_all') {
                await ctx.editMessageText('⏳ جارٍ بدء مهمة إلغاء التثبيت...');
                await startUnpinAllJob(ctx, client); // <-- استدعاء الدالة الجديدة
                return;
            }
        }
        
        if (action === 'user' && parts[1] === 'reply') {
            // ... (No changes needed in this block)
            const targetAdminId = parts[2];
            await updateUserState(userId, { state: 'REPLYING_TO_ADMIN', stateData: { targetAdminId: targetAdminId } });
            await ctx.answerCbQuery();
            return ctx.reply(`أرسل الآن ردك للمشرف المحدد:`);
        }

        if (!userDoc.is_admin) return ctx.answerCbQuery('غير مصرح لك.', { show_alert: true });
        
        if (action === 'confirm_delete_button') {
            // ... (No changes needed in this block, but good that it has BEGIN/COMMIT/ROLLBACK)
            const subAction = parts[1];
            const buttonId = parts[2];
            if (subAction === 'no') {
                await ctx.editMessageText('👍 تم إلغاء عملية الحذف.');
                return ctx.answerCbQuery();
            }
            if (subAction === 'yes') {
                try {
                    await ctx.editMessageText('⏳ جاري الحذف العميق للقسم...');
                    await client.query('BEGIN');
                    await deepDeleteButton(buttonId, client);
                    await client.query('COMMIT');
                    await ctx.editMessageText('🗑️ تم الحذف العميق للقسم بنجاح.');
                    await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');
                    return ctx.answerCbQuery();
                } catch (error) {
                    await client.query('ROLLBACK');
                    console.error("Deep-delete button error:", error);
                    await ctx.editMessageText('❌ حدث خطأ فادح أثناء عملية الحذف.');
                    return ctx.answerCbQuery('فشل الحذف', { show_alert: true });
                }
            }
        }

        if (action === 'admin') {
            // ... (No changes needed in this block)
            const subAction = parts[1];
            const targetId = parts[2];
           if (subAction === 'reply') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_REPLY', stateData: { targetUserId: targetId } });
                await ctx.answerCbQuery();
                return ctx.reply(`أرسل الآن ردك للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
            }
            if (subAction === 'ban') {
                if (targetId === process.env.SUPER_ADMIN_ID) {
                    return ctx.answerCbQuery('🚫 لا يمكن حظر الأدمن الرئيسي.', { show_alert: true });
                }
                await client.query('UPDATE public.users SET banned = true WHERE id = $1', [targetId]);
                await ctx.answerCbQuery();
                await ctx.editMessageText(`🚫 تم حظر المستخدم <code>${targetId}</code> بنجاح.`, { parse_mode: 'HTML' });
                await bot.telegram.sendMessage(targetId, '🚫 لقد تم حظرك من استخدام هذا البوت.').catch(e => console.error(e.message));
                return;
            }
            if (subAction === 'unban') {
                const targetId = parts[2];
                await client.query('UPDATE public.users SET banned = false WHERE id = $1', [targetId]);
                await ctx.answerCbQuery();
                await ctx.editMessageText(`✅ تم فك حظر المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
                await bot.telegram.sendMessage(targetId, '✅ تم فك الحظر عنك. يمكنك الآن استخدام البوت مجددًا.').catch(e => console.error(`Failed to send unban notification to user ${targetId}:`, e.message));
                return;
            }
            if (userId !== process.env.SUPER_ADMIN_ID) return ctx.answerCbQuery('🚫 للمشرف الرئيسي فقط.', { show_alert: true });
            if (subAction === 'add') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_ID_TO_ADD' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف الجديد:');
            }
            if (subAction === 'remove') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_ID_TO_REMOVE' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف للحذف:');
            }
        }

        if (action === 'btn') {
            const subAction = parts[1];
            const buttonId = parts[2];
            
            if (subAction === 'rename') {
                await updateUserState(userId, { state: 'AWAITING_RENAME', stateData: { buttonId: buttonId } });
                await ctx.answerCbQuery();
                await ctx.editMessageText('أدخل الاسم الجديد:');
                return;
            }
           if (subAction === 'delete') {
                const buttonResult = await client.query('SELECT text FROM public.buttons WHERE id = $1', [buttonId]);
                if (buttonResult.rows.length === 0) return ctx.answerCbQuery('الزر غير موجود بالفعل.');

                const buttonName = buttonResult.rows[0].text;

                // Set the state to await for a forced reply
                await updateUserState(userId, { 
                    state: 'AWAITING_DELETE_CONFIRMATION', 
                    stateData: { buttonId: buttonId, buttonName: buttonName } 
                });
                
                await ctx.answerCbQuery();

                // Send a clear warning message and ask for confirmation
                const warningMessage = `️⚠️ **تحذير خطير** ⚠️\n\n` +
                                     `أنت على وشك حذف الزر **"${buttonName}"**.\n\n` +
                                     `سيؤدي هذا إلى **حذف جميع الأزرار الفرعية والرسائل والمحتويات الموجودة بداخله بشكل نهائي ولا يمكن التراجع عن هذا الإجراء.**\n\n` +
                                     `إذا كنت متأكدًا تمامًا، اكتب كلمة "نعم" وأرسلها.`;

                return ctx.reply(warningMessage, { 
                    parse_mode: 'Markdown',
                    reply_markup: { force_reply: true }
                });
            }
            if (subAction === 'adminonly') {
                const buttonResult = await client.query('SELECT admin_only FROM public.buttons WHERE id = $1', [buttonId]);
                const adminOnly = !buttonResult.rows[0].admin_only;
                await client.query('UPDATE public.buttons SET admin_only = $1 WHERE id = $2', [adminOnly, buttonId]);
                await ctx.answerCbQuery(`الزر الآن ${adminOnly ? 'للمشرفين فقط' : 'للجميع'}`);
                return;
            }
            if (subAction === 'stats') {
                // استعلام متقدم (Recursive CTE) لجلب كل الفروع
                const deepStatsQuery = `
                    WITH RECURSIVE descendant_buttons AS (
                        SELECT id FROM public.buttons WHERE id = $1
                        UNION ALL
                        SELECT b.id FROM public.buttons b
                        INNER JOIN descendant_buttons db ON b.parent_id = db.id
                    )
                    SELECT
                        (SELECT COUNT(*) FROM descendant_buttons WHERE id != $1) AS deep_sub_button_count,
                        (SELECT COUNT(*) FROM public.messages WHERE button_id IN (SELECT id FROM descendant_buttons)) AS deep_message_count;
                `;

                const [todayResult, totalClicksResult, deepStatsResult, buttonTextResult] = await Promise.all([
                    client.query(`
                        SELECT COUNT(*) as clicks, COUNT(DISTINCT user_id) as users
                        FROM public.button_clicks_log
                        WHERE button_id = $1 AND (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
                    `, [buttonId]),
                    client.query(`
                        SELECT ((SELECT COUNT(*) FROM public.button_clicks_log WHERE button_id = $1) + 
                                COALESCE((SELECT total_clicks FROM public.lifetime_button_stats WHERE button_id = $1), 0)) AS total;
                    `, [buttonId]),
                    client.query(deepStatsQuery, [buttonId]),
                    client.query('SELECT text FROM public.buttons WHERE id = $1', [buttonId])
                ]);

                const dailyClicks = parseInt(todayResult.rows[0].clicks || 0);
                const dailyUsers = parseInt(todayResult.rows[0].users || 0);
                const totalClicks = parseInt(totalClicksResult.rows[0].total || 0);
                const deepSubButtonsCount = parseInt(deepStatsResult.rows[0].deep_sub_button_count || 0);
                const deepMessagesCount = parseInt(deepStatsResult.rows[0].deep_message_count || 0);
                const buttonName = buttonTextResult.rows[0]?.text || 'غير معروف';

                const statsMessage = `📊 <b>إحصائيات الزر: ${buttonName}</b>\n\n` +
                    `👆 <b>الضغطات (على هذا الزر فقط):</b>\n` +
                    `  - اليوم: <code>${dailyClicks}</code>\n` +
                    `  - الكلي: <code>${totalClicks}</code>\n\n` +
                    `👤 <b>المستخدمون (اليوم):</b> <code>${dailyUsers}</code>\n\n` +
                    `🗂 <b>المحتويات الداخلية (بشكل عميق):</b>\n` +
                    `  - إجمالي الأزرار الفرعية: <code>${deepSubButtonsCount}</code>\n` +
                    `  - إجمالي الرسائل بالداخل: <code>${deepMessagesCount}</code>`;
                
                await ctx.answerCbQuery();
                await ctx.replyWithHTML(statsMessage);
                return;
            }
            
            // ==========================================================
            // |      =============== THE FIX IS HERE (BUTTONS) ===============      |
            // ==========================================================
            if (['up', 'down', 'left', 'right'].includes(subAction)) {
                // This entire block is now wrapped in a try/catch to handle rollbacks
                try {
                    const btnToMoveResult = await client.query('SELECT parent_id FROM public.buttons WHERE id = $1', [buttonId]);
                    if (btnToMoveResult.rows.length === 0) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                    const parentId = btnToMoveResult.rows[0].parent_id;

                    const buttonsResult = await client.query(
                        'SELECT id, "order", is_full_width FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL') + ' ORDER BY "order"',
                        parentId ? [parentId] : []
                    );
                    const buttonList = buttonsResult.rows;
                    
                    let rows = [];
                    let currentRow = [];
                    buttonList.forEach(btn => {
                        currentRow.push(btn);
                        if (btn.is_full_width || currentRow.length === 2) {
                            rows.push(currentRow);
                            currentRow = [];
                        }
                    });
                    if (currentRow.length > 0) rows.push(currentRow);

                    let targetRowIndex = -1, targetColIndex = -1;
                    rows.find((row, rIndex) => {
                        const cIndex = row.findIndex(b => b.id === buttonId);
                        if (cIndex !== -1) {
                            targetRowIndex = rIndex;
                            targetColIndex = cIndex;
                            return true;
                        }
                        return false;
                    });
                    if (targetRowIndex === -1) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                    
                    let actionTaken = false;
                    // ... (Movement logic for up, down, left, right remains the same)
                    if (subAction === 'up') {
                        if (rows[targetRowIndex].length > 1) { 
                            const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0];
                            const self = rows[targetRowIndex][targetColIndex];
                            rows.splice(targetRowIndex, 1, [self], [partner]);
                            actionTaken = true;
                        } else if (targetRowIndex > 0 && rows[targetRowIndex - 1].length === 1) {
                            const buttonAbove = rows[targetRowIndex - 1][0];
                            const self = rows[targetRowIndex][0];
                            rows[targetRowIndex - 1] = [buttonAbove, self];
                            rows.splice(targetRowIndex, 1);
                            actionTaken = true;
                        }
                    } else if (subAction === 'down') {
                        if (rows[targetRowIndex].length > 1) { 
                            const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0];
                            const self = rows[targetRowIndex][targetColIndex];
                            rows.splice(targetRowIndex, 1, [partner], [self]);
                            actionTaken = true;
                        } else if (targetRowIndex < rows.length - 1 && rows[targetRowIndex + 1].length === 1) {
                            const buttonBelow = rows[targetRowIndex + 1][0];
                            const self = rows[targetRowIndex][0];
                            rows.splice(targetRowIndex, 1);
                            rows[targetRowIndex] = [self, buttonBelow];
                            actionTaken = true;
                        }
                    } else if (['left', 'right'].includes(subAction)) {
                        if (rows[targetRowIndex].length > 1) {
                            [rows[targetRowIndex][0], rows[targetRowIndex][1]] = [rows[targetRowIndex][1], rows[targetRowIndex][0]];
                            actionTaken = true;
                        }
                    }

                    if (actionTaken) {
                        const newButtonList = rows.flat();
                        await client.query('BEGIN'); // Start transaction
                        for (let i = 0; i < newButtonList.length; i++) {
                            const button = newButtonList[i];
                            const finalRow = rows.find(r => r.some(b => b.id === button.id));
                            const newIsFullWidth = finalRow.length === 1;
                            await client.query('UPDATE public.buttons SET "order" = $1, is_full_width = $2 WHERE id = $3', [i, newIsFullWidth, button.id]);
                        }
                        await client.query('COMMIT'); // Commit transaction
                        await refreshKeyboardView(ctx, userId, '✅ تم تحديث ترتيب الأزرار.');
                        await ctx.answerCbQuery();
                    } else {
                        await ctx.answerCbQuery('لا يمكن تحريك الزر أكثر.', { show_alert: true });
                    }
                } catch (e) {
                    await client.query('ROLLBACK'); // Rollback on error
                    console.error("Error updating button order:", e);
                    await ctx.reply('❌ حدث خطأ أثناء تحديث الترتيب.');
                }
                return;
            }
        }
     if (action === 'msg') {
            const msgAction = parts[1];
            const messageId = parts[2];

            const msgResult = await client.query('SELECT *, button_id FROM public.messages WHERE id = $1', [messageId]);
            if (msgResult.rows.length === 0) return ctx.answerCbQuery('الرسالة غير موجودة');
            
            const messageToHandle = msgResult.rows[0];
            const buttonId = messageToHandle.button_id;

            const messagesResult = await client.query('SELECT * FROM public.messages WHERE button_id = $1 ORDER BY "order"', [buttonId]);
            const messages = messagesResult.rows;
            const messageIndex = messages.findIndex(msg => msg.id === messageId);
            if (messageIndex === -1) return ctx.answerCbQuery('الرسالة غير موجودة');

            if (msgAction === 'delete') {
                await client.query('DELETE FROM public.messages WHERE id = $1', [messageId]);
                await client.query('UPDATE public.messages SET "order" = "order" - 1 WHERE button_id = $1 AND "order" > $2', [buttonId, messages[messageIndex].order]);
                await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                await refreshAdminView(ctx, userId, buttonId, '🗑️ تم الحذف بنجاح.');
                return ctx.answerCbQuery();
            }
            
            if (msgAction === 'up' || msgAction === 'down') {
                const currentMessage = messages[messageIndex];
                const newOrder = msgAction === 'up' ? currentMessage.order - 1 : currentMessage.order + 1;
                
                const targetMessage = messages.find(m => m.order === newOrder);

                if (targetMessage) {

                 // This replaces the entire try...catch block inside if (targetMessage)
const transactionClient = await getClient(); // We get a dedicated client for the transaction
try {
    const currentOrderInt = parseInt(currentMessage.order, 10);
    const targetOrderInt = parseInt(targetMessage.order, 10);

    if (isNaN(currentOrderInt) || isNaN(targetOrderInt)) {
        await ctx.reply('❌ حدث خطأ: قيمة الترتيب غير صالحة.');
        return ctx.answerCbQuery('Invalid order value', { show_alert: true });
    }

    // --- The Correct 3-Step Swap inside a Transaction ---

    await transactionClient.query('BEGIN'); // 1. Start the transaction

    // 2. Move the first message to a temporary, non-conflicting spot (-1)
    await transactionClient.query(
        'UPDATE public.messages SET "order" = -1 WHERE id = $1 AND button_id = $2',
        [currentMessage.id, buttonId]
    );

    // 3. Move the second message into the first message's now-vacant spot
    await transactionClient.query(
        'UPDATE public.messages SET "order" = $1 WHERE id = $2 AND button_id = $3',
        [currentOrderInt, targetMessage.id, buttonId]
    );

    // 4. Move the first message from the temporary spot into the second message's original spot
    await transactionClient.query(
        'UPDATE public.messages SET "order" = $1 WHERE id = $2 AND button_id = $3',
        [targetOrderInt, currentMessage.id, buttonId]
    );

    await transactionClient.query('COMMIT'); // 5. If all steps succeed, commit the changes

    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
    await refreshAdminView(ctx, userId, buttonId, '↕️ تم تحديث الترتيب بنجاح.');

} catch (e) {
    await transactionClient.query('ROLLBACK'); // If any step fails, undo everything
    console.error("Error updating message order (transaction rolled back):", e);
    await ctx.reply('❌ حدث خطأ فادح أثناء تحديث الترتيب.');
    
} finally {
    transactionClient.release(); // IMPORTANT: Always release the client back to the pool
}
                } else {
                    return ctx.answerCbQuery('لا يمكن تحريك الرسالة أكثر.');
                }
                return ctx.answerCbQuery();
            }
            
            if (msgAction === 'edit') {
                 await updateUserState(userId, { state: 'AWAITING_EDITED_TEXT', stateData: { messageId: messageId, buttonId: buttonId } });
                 await ctx.answerCbQuery();
                 return ctx.reply("📝 أرسل أو وجّه المحتوى الجديد :", { reply_markup: { force_reply: true } });
            }
            if (msgAction === 'edit_caption') {
                await updateUserState(userId, { state: 'AWAITING_NEW_CAPTION', stateData: { messageId: messageId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه رسالة تحتوي على الشرح الجديد:", { reply_markup: { force_reply: true } });
            }
            if (msgAction === 'replace_file') {
                await updateUserState(userId, { state: 'AWAITING_REPLACEMENT_FILE', stateData: { messageId: messageId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("🔄 أرسل أو وجّه الملف الجديد:", { reply_markup: { force_reply: true } });
            }
            if (msgAction === 'addnext') {
                const msg = messages[messageIndex];
                await updateUserState(userId, { state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId, targetOrder: msg.order + 1 } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه الرسالة التالية:", { reply_markup: { force_reply: true } });
            }
        }
        
    } catch (error) {
        console.error("FATAL ERROR in callback_query handler:", error);
        console.error("Caused by callback_query data:", JSON.stringify(ctx.update.callback_query, null, 2));
        await ctx.answerCbQuery("حدث خطأ فادح.", { show_alert: true });
    } finally {
        client.release();
    }
});

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
