package com.surebrowser.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** adb shell am broadcast -a com.surebrowser.TEST --es op import --es text "..." (yalnızca debug APK) */
class TestHook : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val p = goAsync()
        Thread {
            try {
                when (intent.getStringExtra("op")) {
                    "import" -> Log.i("SBTEST", "import|" + Store.str(ctx, "import", intent.getStringExtra("text")!!.replace("~~", "\n"), Store.bundle("type" to "http")))
                    "state" -> Log.i("SBTEST", "state|" + Store.str(ctx, "state"))
                    "note" -> Store.call(ctx, "updateProxy", intent.getStringExtra("id"), Store.bundle("note" to intent.getStringExtra("note")))
                    "open" -> {
                        val ident = intent.getStringExtra("ident")!!
                        val slot = Store.call(ctx, "openSlot", ident).getInt("slot", -1)
                        Log.i("SBTEST", "slot|$ident|$slot")
                        ctx.startActivity(Intent(ctx, Class.forName("com.surebrowser.app.Browser$slot")).putExtra("ident", ident)
                            .putExtra("url", intent.getStringExtra("url")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                }
            } finally { p.finish() }
        }.start()
    }
}
