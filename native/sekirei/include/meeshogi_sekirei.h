#ifndef MEESHOGI_SEKIREI_H
#define MEESHOGI_SEKIREI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Load and verify the bundled SEKIRW01 model. Returns 0 on success. */
int32_t meeshogi_sekirei_init(const char *model_path);

/**
 * Analyze an SFEN position. The returned UTF-8 JSON string is owned by Rust
 * and must be released with meeshogi_sekirei_free_string.
 */
char *meeshogi_sekirei_analyze(const char *sfen, uint64_t nodes, uint32_t multi_pv);

/** Request cancellation of the active request. Safe when no request is active. */
void meeshogi_sekirei_cancel(void);

/** Release a string returned by meeshogi_sekirei_analyze. */
void meeshogi_sekirei_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* MEESHOGI_SEKIREI_H */
