package com.meeshogi.testclipboard;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Gravity;
import android.widget.TextView;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** CI-only ACTION_SEND receiver used to verify the app's KIF export bytes. */
public final class ShareReceiverActivity extends Activity {
  // MediaStore appends .txt to unrecognized extensions for text/plain.
  private static final String OUTPUT_NAME = "meeshogi-export.txt";
  private static final String OUTPUT_MIME = "text/plain";
  private static final String PREF_LAST_OUTPUT = "last_output_uri";

  private TextView statusView;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    statusView = new TextView(this);
    statusView.setGravity(Gravity.CENTER);
    statusView.setText("Preparing export test");
    setContentView(statusView);
    handleIntent(getIntent());
  }

  @Override public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleIntent(intent);
  }

  private void handleIntent(Intent intent) {
    if (intent == null
        || !Intent.ACTION_SEND.equals(intent.getAction())
        || !OUTPUT_MIME.equals(intent.getType())) {
      fail("Expected ACTION_SEND text/plain");
      return;
    }

    Uri source = streamUri(intent);
    if (source == null) {
      fail("Expected EXTRA_STREAM content URI");
      return;
    }

    try {
      Uri destination = saveToDownloads(source);
      statusView.setText("Saved " + OUTPUT_NAME);
      setResult(RESULT_OK, new Intent().setData(destination));
      finish();
    } catch (Exception error) {
      fail("Export failed: " + error.getClass().getSimpleName());
    }
  }

  private static Uri streamUri(Intent intent) {
    if (Build.VERSION.SDK_INT >= 33) {
      return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
    }
    @SuppressWarnings("deprecation")
    Uri legacy = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
    return legacy;
  }

  private Uri saveToDownloads(Uri source) throws IOException {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw new IOException("MediaStore Downloads requires Android 10 or newer");
    }

    ContentResolver resolver = getContentResolver();
    deletePreviousOutput(resolver);

    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, OUTPUT_NAME);
    values.put(MediaStore.MediaColumns.MIME_TYPE, OUTPUT_MIME);
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);

    Uri downloads = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    Uri destination = resolver.insert(downloads, values);
    if (destination == null) {
      throw new IOException("MediaStore insert returned no URI");
    }

    try {
      copyUri(resolver, source, destination);
      ContentValues publish = new ContentValues();
      publish.put(MediaStore.MediaColumns.IS_PENDING, 0);
      if (resolver.update(destination, publish, null, null) != 1) {
        throw new IOException("MediaStore publish failed");
      }
      getPreferences(MODE_PRIVATE)
          .edit()
          .putString(PREF_LAST_OUTPUT, destination.toString())
          .apply();
      return destination;
    } catch (Exception error) {
      resolver.delete(destination, null, null);
      if (error instanceof IOException) {
        throw (IOException) error;
      }
      throw new IOException("MediaStore write failed", error);
    }
  }

  private static void copyUri(ContentResolver resolver, Uri source, Uri destination)
      throws IOException {
    try (InputStream input = resolver.openInputStream(source);
        OutputStream output = resolver.openOutputStream(destination, "w")) {
      if (input == null || output == null) {
        throw new IOException("Unable to open shared URI");
      }
      byte[] buffer = new byte[8192];
      int count;
      while ((count = input.read(buffer)) != -1) {
        output.write(buffer, 0, count);
      }
      output.flush();
    }
  }

  private void deletePreviousOutput(ContentResolver resolver) {
    String previous = getPreferences(MODE_PRIVATE).getString(PREF_LAST_OUTPUT, null);
    if (previous != null) {
      try {
        resolver.delete(Uri.parse(previous), null, null);
      } catch (RuntimeException ignored) {
        // A manually removed or expired helper-owned output is already gone.
      }
      getPreferences(MODE_PRIVATE).edit().remove(PREF_LAST_OUTPUT).apply();
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return;
    }

    Uri downloads = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    String selection = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
        + MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=?";
    String[] selectionArgs = {OUTPUT_NAME, getPackageName()};
    try (Cursor cursor = resolver.query(
        downloads,
        new String[] {MediaStore.MediaColumns._ID},
        selection,
        selectionArgs,
        null)) {
      if (cursor == null) {
        return;
      }
      int idColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
      while (cursor.moveToNext()) {
        resolver.delete(ContentUris.withAppendedId(downloads, cursor.getLong(idColumn)), null, null);
      }
    } catch (RuntimeException ignored) {
      // The preference URI remains the primary cleanup path. A provider that
      // hides owner metadata must not make the helper delete other files.
    }
  }

  private void fail(String message) {
    statusView.setText(message);
    setResult(RESULT_CANCELED);
  }
}
