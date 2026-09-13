package com.meeshogi.testclipboard;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Bundle;
import android.util.Base64;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;

/** Test APK only: loads a UTF-8 KIF into the real Android clipboard. */
public final class ClipboardActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    TextView view = new TextView(this);
    view.setText("Preparing test clipboard");
    setContentView(view);
    String payload = getIntent().getStringExtra("payload");
    if (payload == null) { finish(); return; }
    String text = new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8);
    view.post(() -> {
      ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
      clipboard.setPrimaryClip(ClipData.newPlainText("KIF fixture", text));
      view.postDelayed(this::finish, 300);
    });
  }
}
