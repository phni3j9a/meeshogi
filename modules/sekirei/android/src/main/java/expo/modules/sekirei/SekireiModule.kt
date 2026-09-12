package expo.modules.sekirei

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

private const val MODEL_ASSET = "c-leaf-wrm-seed42.bin"
private const val MODEL_SIZE = 1_305_356L

/** Expo boundary for the process-global Rust Sekirei bridge. */
class SekireiModule : Module() {
  init {
    System.loadLibrary("meeshogi_sekirei")
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  @Volatile
  private var modelPath: String? = null

  override fun definition() = ModuleDefinition {
    Name("MeeshogiSekirei")

    AsyncFunction("initializeAsync") Coroutine {
      withContext(Dispatchers.IO) {
        val path = ensureModelFile()
        if (nativeInit(path) != 0) {
          throw IllegalStateException("Sekirei model validation failed")
        }
      }
    }

    AsyncFunction("analyzeAsync") Coroutine { sfen: String, nodes: Long, multiPV: Int ->
      withContext(Dispatchers.Default) {
        val result = nativeAnalyze(sfen, nodes, multiPV)
          ?: throw IllegalStateException("Sekirei returned no analysis")
        result
      }
    }

    AsyncFunction("cancelAsync") {
      nativeCancel()
    }
  }

  private fun ensureModelFile(): String {
    modelPath?.let { return it }
    synchronized(this) {
      modelPath?.let { return it }
      val destination = File(context.filesDir, MODEL_ASSET)
      if (!destination.isFile || destination.length() != MODEL_SIZE) {
        context.assets.open(MODEL_ASSET).use { input ->
          FileOutputStream(destination).use { output -> input.copyTo(output) }
        }
      }
      check(destination.isFile && destination.length() == MODEL_SIZE) {
        "Bundled Sekirei model has an unexpected size"
      }
      return destination.absolutePath.also { modelPath = it }
    }
  }

  private external fun nativeInit(modelPath: String): Int
  private external fun nativeAnalyze(sfen: String, nodes: Long, multiPV: Int): String?
  private external fun nativeCancel()
}
