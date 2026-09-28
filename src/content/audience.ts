import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Department } from '../common/enum/department.enum';
import { Institution } from '../common/enum/institution.enum';
import { Level } from '../common/enum/level.enum';

/**
 * Who a course is for. Curricula differ between schools, so a course carries
 * a list of rules, e.g. Anatomy → "200 Level · MBBS · any school" and
 * "100 Level · Nursing Science · University of Lagos".
 *
 * A rule always names a level; department and institution are optional
 * ("any"). A course with no rules is for everyone. Topics and questions
 * follow their course.
 */
@Schema({ _id: false })
export class AudienceRule {
  @Prop({ type: String, enum: Object.values(Level), required: true })
  level: Level;

  @Prop({ type: String, enum: Object.values(Department) })
  department?: Department;

  @Prop({ type: String, enum: Object.values(Institution) })
  institution?: Institution;
}

export const AudienceRuleSchema = SchemaFactory.createForClass(AudienceRule);

/** The parts of a student's profile that decide what's "for you". */
export type StudentAcademics = {
  level?: string;
  department?: string;
  institution?: string;
};

/**
 * True when the course is meant for this student. Students who haven't set a
 * level can't be matched, so everything counts as theirs.
 */
export function isForStudent(rules: AudienceRule[] | undefined, student?: StudentAcademics): boolean {
  if (!rules?.length || !student?.level) return true;
  return rules.some(
    rule =>
      rule.level === student.level &&
      (!rule.department || rule.department === student.department) &&
      (!rule.institution || rule.institution === student.institution),
  );
}

/** Plain copies for JSON (Mongoose sub-documents carry parent links). */
export const presentAudience = (rules: AudienceRule[] | undefined) =>
  (rules ?? []).map(({ level, department, institution }) => ({
    level,
    ...(department ? { department } : {}),
    ...(institution ? { institution } : {}),
  }));

/** Drops "any" blanks and duplicate rules, keeping the given order. */
export function cleanAudience(rules: { level: Level; department?: Department | ''; institution?: Institution | '' }[]) {
  const seen = new Set<string>();
  return rules
    .map(({ level, department, institution }) => ({
      level,
      ...(department ? { department } : {}),
      ...(institution ? { institution } : {}),
    }))
    .filter(rule => {
      const key = [rule.level, rule.department ?? '', rule.institution ?? ''].join('|');
      return !seen.has(key) && seen.add(key);
    });
}
