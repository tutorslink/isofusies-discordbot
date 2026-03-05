const CREATEAD_LEVEL_CONFIG = {
    a_level: { categoryName: 'AS/A Level Tutors' },
    university: { categoryName: 'University Tutors' },
    language: { categoryName: 'Language Tutors' }
};

const findSubjectChannel = /^(igcse\/gcse|as\/al|as\/a\\s+level|a-level|igcse\/o-level|below\\s+igcse|university|language)\\s+/i;

module.exports = { CREATEAD_LEVEL_CONFIG, findSubjectChannel };