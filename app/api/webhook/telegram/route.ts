import { NextResponse } from 'next/server';
import { bot } from '@/lib/telegram/bot';
import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1. TANGANI PESAN TEKS
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text.trim();

      // FITUR LINKING AKUN: Menangani /start KODE_OTP
      if (text.startsWith('/start')) {
        const parts = text.split(' ');
        const code = parts[1]; // Mengambil kode unik (misal: 123456)

        if (code) {
          // Cari user yang memiliki verification code ini
          const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name')
            .eq('telegram_verification_code', code)
            .single();

          if (profile) {
            // Update telegram_chat_id user & bersihkan kode unik
            await supabaseAdmin
              .from('profiles')
              .update({
                telegram_chat_id: chatId,
                telegram_verification_code: null,
              })
              .eq('id', profile.id);

            await bot.api.sendMessage(
              chatId,
              `🎉 **Akun Berhasil Terhubung!**\n\nHalo ${profile.full_name || 'User'}, akun Hemat.in kamu sudah terhubung dengan bot ini.\n\nSekarang kamu bisa langsung mencatat pengeluaran/pemasukan dengan **mengetikkan angka nominal saja** di sini (contoh: \`50000\`).`,
              { parse_mode: 'Markdown' }
            );
            return NextResponse.json({ ok: true });
          } else {
            await bot.api.sendMessage(
              chatId,
              '❌ **Kode verifikasi salah atau sudah kadaluwarsa.** Silakan generate kode baru dari halaman Settings di website Hemat.in.'
            );
            return NextResponse.json({ ok: true });
          }
        }

        // Jika /start tanpa kode OTP
        await bot.api.sendMessage(
          chatId,
          '👋 **Selamat datang di Hemat.in Bot!**\n\nUntuk menghubungkan akun, buka website Hemat.in -> Settings -> Hubungkan Telegram.',
          { parse_mode: 'Markdown' }
        );
        return NextResponse.json({ ok: true });
      }

      // CEK APAKAH USER SUDAH LINKING AKUN
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('telegram_chat_id', chatId)
        .single();

      if (!profile) {
        await bot.api.sendMessage(
          chatId,
          '⚠️ **Akun Telegram kamu belum terhubung.**\n\nSilakan login ke website Hemat.in dan klik "Hubungkan Telegram" di halaman Settings.',
          { parse_mode: 'Markdown' }
        );
        return NextResponse.json({ ok: true });
      }

      // PARSER NOMINAL
      const amount = parseFloat(text.replace(/[^0-9]/g, ''));
      if (!isNaN(amount) && amount > 0) {
        // Simpan session sementara ke DB
        await supabaseAdmin.from('telegram_sessions').upsert({
          chat_id: chatId,
          step: 'AWAITING_TYPE',
          amount: amount,
          updated_at: new Date().toISOString(),
        });

        const keyboard = new InlineKeyboard()
          .text('🔴 Pengeluaran', `type:expense`)
          .text('🟢 Pemasukan', `type:income`);

        await bot.api.sendMessage(
          chatId,
          `💰 Nominal: **Rp${amount.toLocaleString('id-ID')}**\n\nPilih jenis transaksi:`,
          { reply_markup: keyboard, parse_mode: 'Markdown' }
        );
      } else {
        await bot.api.sendMessage(chatId, 'Ketik nominal angka yang valid, contoh: `50000`');
      }
    }

    // 2. TANGANI KLIK INLINE BUTTON (CALLBACK QUERY)
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const data = body.callback_query.data;

      const { data: session } = await supabaseAdmin
        .from('telegram_sessions')
        .select('*')
        .eq('chat_id', chatId)
        .single();

      if (!session) {
        await bot.api.sendMessage(chatId, 'Sesi kadaluwarsa. Silakan ketik nominal angka kembali.');
        return NextResponse.json({ ok: true });
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('telegram_chat_id', chatId)
        .single();

      // CASE 1: Pilih Tipe Transaksi
      if (data.startsWith('type:')) {
        const type = data.split(':')[1];

        await supabaseAdmin
          .from('telegram_sessions')
          .update({ type: type, step: 'AWAITING_CATEGORY' })
          .eq('chat_id', chatId);

        const { data: categories } = await supabaseAdmin
          .from('categories')
          .select('id, name')
          .eq('user_id', profile?.id)
          .eq('type', type);

        const keyboard = new InlineKeyboard();
        categories?.forEach((cat, index) => {
          keyboard.text(cat.name, `cat:${cat.id}`);
          if ((index + 1) % 2 === 0) keyboard.row();
        });

        await bot.api.sendMessage(chatId, '📂 **Pilih Kategori:**', {
          reply_markup: keyboard,
          parse_mode: 'Markdown',
        });
      }

      // CASE 2: Pilih Kategori & Simpan Ke Database
      else if (data.startsWith('cat:')) {
        const categoryId = data.split(':')[1];

        const { data: account } = await supabaseAdmin
          .from('accounts')
          .select('id')
          .eq('user_id', profile?.id)
          .eq('is_default', true)
          .single();

        await supabaseAdmin.from('transactions').insert({
          user_id: profile?.id,
          account_id: account?.id,
          category_id: categoryId,
          amount: session.amount,
          type: session.type,
          description: 'Pencatatan via Telegram Bot',
          date: new Date().toISOString().split('T')[0],
        });

        await supabaseAdmin.from('telegram_sessions').delete().eq('chat_id', chatId);

        await bot.api.sendMessage(
          chatId,
          `✅ **Berhasil Dicatat!**\n\n• Jenis: ${session.type === 'expense' ? '🔴 Pengeluaran' : '🟢 Pemasukan'}\n• Nominal: **Rp${session.amount.toLocaleString('id-ID')}**`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error Webhook Telegram:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}