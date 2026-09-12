#ifndef MEESHOGI_SEKIREI_H
#define MEESHOGI_SEKIREI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Load and verify the bundled SEKIRW01 model. Returns 0 on success. */
int32_t meeshogi_sekirei_init(const char *model_path);

/** Allocate a monotonic request identity before dispatching a search. */
uint64_t meeshogi_sekirei_prepare_request(void);

/**
 * Analyze an SFEN position. The returned UTF-8 JSON string is owned by Rust
 * and must be released with meeshogi_sekirei_free_string.
 */
char *meeshogi_sekirei_analyze(
    const char *sfen,
    uint64_t nodes,
    uint32_t multi_pv,
    uint64_t request_id
);

/** Request cancellation of one request, including before active registration. */
void meeshogi_sekirei_cancel(uint64_t request_id);

/** Release a string returned by meeshogi_sekirei_analyze. */
void meeshogi_sekirei_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* MEESHOGI_SEKIREI_H */
