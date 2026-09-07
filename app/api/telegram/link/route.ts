import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const { userId } = await req.json();

    // Generate kode acak 6 digit
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Simpan kode ke profil user
    await supabaseAdmin
      .from('profiles')
      .update({ telegram_verification_code: code })
      .eq('id', userId);

    const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'hematin_tracker_bot';
    const link = `https://t.me/${botUsername}?start=${code}`;

    return NextResponse.json({ link, code });
  } catch (error) {
    return NextResponse.json({ error: 'Gagal membuat link' }, { status: 500 });
  }
}