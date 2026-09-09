#!/usr/bin/env python3
"""Replay ONLY the two repository fixtures into fixed visual mock data.

Not a general KIF parser or legality engine. This checks source ownership,
piece notation, captures, hand inventory and total inventory while preparing
the reviewed fixture frames; the browser consumes the resulting snapshots.
"""
import copy
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
GLYPHS = {'歩': 'P', '香': 'L', '桂': 'N', '銀': 'S', '金': 'G', '角': 'B', '飛': 'R', '玉': 'K', '王': 'K', 'と': '+P', '杏': '+L', '圭': '+N', '全': '+S', '馬': '+B', '龍': '+R', '竜': '+R'}
TRANSLATE = str.maketrans('１２３４５６７８９', '123456789')
RANKS = '一二三四五六七八九'


def index(file, rank):
    return (rank - 1) * 9 + 9 - file


def initial():
    board = [''] * 81
    for col, piece in enumerate('LNSGKGSNL'):
        board[col] = piece.lower()
        board[72 + col] = piece
        board[18 + col] = 'p'
        board[54 + col] = 'P'
    board[10], board[16], board[64], board[70] = 'r', 'b', 'B', 'R'
    return {'board': board, 'hands': [{}, {}], 'from': None, 'to': None, 'label': '開始局面'}


def move(state, origin, target, side, promote=False, drop=None, label=''):
    state = copy.deepcopy(state)
    board, hands = state['board'], state['hands']
    if drop:
        assert not board[target] and hands[side].get(drop, 0) > 0
        hands[side][drop] -= 1
        piece = drop if side == 0 else drop.lower()
    else:
        piece = board[origin]
        assert piece and piece[-1].isupper() == (side == 0), (label, origin, piece, side)
        board[origin] = ''
    if board[target]:
        assert board[target][-1].isupper() != (side == 0)
        captured = board[target][-1].upper()
        assert captured != 'K'
        hands[side][captured] = hands[side].get(captured, 0) + 1
    if promote and not piece.startswith('+'):
        piece = '+' + piece
    board[target] = piece
    state.update({'from': origin, 'to': target, 'label': label})
    inventory = Counter(p[-1].upper() for p in board if p)
    for hand in hands:
        inventory.update(hand)
    assert inventory == Counter({'P': 18, 'L': 4, 'N': 4, 'S': 4, 'G': 4, 'B': 2, 'R': 2, 'K': 2}), inventory
    return state


def prepare(filename, names, date):
    raw = (REPO / 'fixtures/kif' / filename).read_text()
    raw = re.sub(r'(?m)^(先手：).*$', lambda m: m[1] + names[0], raw)
    raw = re.sub(r'(?m)^(後手：).*$', lambda m: m[1] + names[1], raw)
    raw = re.sub(r'(?m)^(開始日時：).*$', lambda m: m[1] + date, raw)
    raw = re.sub(r'(?m)^終了日時：.*\n', '', raw)
    raw = re.sub(r'(?m)^(先手段級|後手段級)：.*\n', '', raw)
    frames = [initial()]
    labels = ['開始局面']
    last = None
    for line in raw.splitlines():
        match = re.match(r'\s*(\d+)\s+(.+)', line)
        if not match or match[2].startswith('投了'):
            continue
        n, notation = int(match[1]), match[2]
        assert n == len(frames)
        side = (n - 1) % 2
        if notation.startswith('同'):
            target = last
            notation = re.sub(r'^同[\s　]*', '', notation)
            dest_label = '同'
        else:
            f = int(notation[0].translate(TRANSLATE))
            rank = RANKS.index(notation[1]) + 1 if notation[1] in RANKS else int(notation[1].translate(TRANSLATE))
            target = index(f, rank)
            dest_label = str(f).translate(str.maketrans('123456789', '１２３４５６７８９')) + RANKS[rank - 1]
            notation = notation[2:]
        piece_label = notation[0]
        token = GLYPHS[piece_label]
        origin_match = re.search(r'\((\d)(\d)\)', notation)
        origin = index(int(origin_match[1]), int(origin_match[2])) if origin_match else None
        drop = token if '打' in notation.split('(')[0] else None
        promotion = '成' in notation.split('(')[0] and '不成' not in notation
        if origin is not None:
            assert frames[-1]['board'][origin].upper() == token, (filename, n, notation)
        label = ('▲' if side == 0 else '△') + dest_label + piece_label + ('成' if promotion else '') + ('打' if drop else '')
        frames.append(move(frames[-1], origin, target, side, promotion, drop, label))
        labels.append(label)
        last = target
    return {'raw': raw, 'frames': frames, 'labels': labels}


def main():
    wars = prepare('shogiwars.kif', ['ao_ki', 'sample_player'], '2026/09/08 20:16:00')
    journal = prepare('kiou.kif', ['sample_player', 'sora_27'], '2026/09/09 19:42:00')
    for game, names, time in [(wars, ['sample_ao', 'sample_player'], '21:03:00'), (journal, ['sample_player', 'sample_sora'], '21:00:00')]:
        raw = re.sub(r'(?m)^先手：.*$', '先手：' + names[0], game['raw'])
        raw = re.sub(r'(?m)^後手：.*$', '後手：' + names[1], raw)
        game['importRaw'] = re.sub(r'(?m)^開始日時：.*$', '開始日時：2026/09/09 ' + time, raw)
    branch = [copy.deepcopy(journal['frames'][32])]
    for origin, target, side, label in [(index(4, 7), index(3, 6), 0, '▲３六銀'), (index(3, 5), index(3, 6), 1, '△同銀'), (index(3, 8), index(3, 6), 0, '▲同飛')]:
        branch.append(move(branch[-1], origin, target, side, label=label))
    data = {'games': {'wars': wars, 'journal': journal}, 'branch': branch}
    (HERE / 'demo-data.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    print(f'Prepared {len(wars["frames"])} + {len(journal["frames"])} mainline frames and {len(branch)} branch frames. Inventory and notation checks passed.')


if __name__ == '__main__':
    main()
