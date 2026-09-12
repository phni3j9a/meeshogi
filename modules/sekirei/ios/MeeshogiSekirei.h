#ifndef MEESHOGI_SEKIREI_H
#define MEESHOGI_SEKIREI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t meeshogi_sekirei_init(const char *model_path);
char *meeshogi_sekirei_analyze(const char *sfen, uint64_t nodes, uint32_t multi_pv);
void meeshogi_sekirei_cancel(void);
void meeshogi_sekirei_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif
