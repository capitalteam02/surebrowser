package com.surebrowser.app

import android.content.Context
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Küçük kod-içi arayüz yardımcıları (XML yerleşim yok). */
object Pal {
    fun dark(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    fun bg(ctx: Context) = if (dark(ctx)) 0xFF1B1B1A.toInt() else 0xFFECEBE8.toInt()
    fun bar(ctx: Context) = if (dark(ctx)) 0xFF262624.toInt() else 0xFFF7F7F5.toInt()
    fun surface(ctx: Context) = if (dark(ctx)) 0xFF2E2E2C.toInt() else 0xFFFFFFFF.toInt()
    fun ink(ctx: Context) = if (dark(ctx)) 0xFFECEBE7.toInt() else 0xFF1F1F1D.toInt()
    fun muted(ctx: Context) = if (dark(ctx)) 0xFFA09F99.toInt() else 0xFF6D6C67.toInt()
    fun line(ctx: Context) = if (dark(ctx)) 0xFF3A3A37.toInt() else 0xFFD8D6D0.toInt()
    const val OK = 0xFF2F8A46.toInt()
    const val DANGER = 0xFFC8372D.toInt()
    const val WARN = 0xFFB3600B.toInt()
    const val ACCENT = 0xFF0B6BCB.toInt()
}

fun Context.dp(v: Number): Int = (v.toFloat() * resources.displayMetrics.density + 0.5f).toInt()

fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeW: Int = 0) = GradientDrawable().apply {
    setColor(color); cornerRadius = radius
    if (strokeW > 0) setStroke(strokeW, stroke)
}

fun View.ripple(bg: GradientDrawable) {
    background = RippleDrawable(ColorStateList.valueOf(0x33000000), bg, null)
}

fun Context.text(s: CharSequence, size: Float = 14f, color: Int = Pal.ink(this), bold: Boolean = false, lines: Int = 0): TextView =
    TextView(this).apply {
        text = s; textSize = size; setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        if (lines > 0) { maxLines = lines; ellipsize = TextUtils.TruncateAt.END }
    }

fun Context.button(s: String, primary: Boolean = false, onClick: () -> Unit): Button = Button(this).apply {
    text = s; isAllCaps = false; textSize = 14f; minHeight = dp(44); minimumHeight = dp(44)
    setPadding(dp(16), 0, dp(16), 0)
    setTextColor(if (primary) Pal.bar(context) else Pal.ink(context))
    stateListAnimator = null
    ripple(rounded(if (primary) Pal.ink(context) else Pal.surface(context), dp(10).toFloat(), Pal.line(context), if (primary) 0 else dp(1)))
    setOnClickListener { onClick() }
}

fun Context.vbox(pad: Int = 0) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
fun Context.hbox(pad: Int = 0) = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(pad, pad, pad, pad) }

fun lp(w: Int = ViewGroup.LayoutParams.MATCH_PARENT, h: Int = ViewGroup.LayoutParams.WRAP_CONTENT, weight: Float = 0f) =
    LinearLayout.LayoutParams(w, h, weight)

fun LinearLayout.add(v: View, l: ViewGroup.LayoutParams? = null): LinearLayout { if (l != null) addView(v, l) else addView(v); return this }
fun LinearLayout.LayoutParams.margins(l: Int = 0, t: Int = 0, r: Int = 0, b: Int = 0) = apply { setMargins(l, t, r, b) }

/** Android 15 kenardan kenara çizim: içerik durum çubuğu, gezinme çubuğu ve klavyenin altında kalmasın. */
fun View.fitSystemBars() {
    setOnApplyWindowInsetsListener { v, insets ->
        val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
        val ime = insets.getInsets(android.view.WindowInsets.Type.ime())
        v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
        android.view.WindowInsets.CONSUMED
    }
    requestApplyInsets()
}
